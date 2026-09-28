import { lstat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";

import type { AsyncSubscription, Event } from "@parcel/watcher";
import type { Context, RootContext } from "@steve.kite/stdlib";

import type { ScanGitRunner } from "../runScanGit.js";

/** Directories no working tree needs watched, whether or not Git ignores them. */
const ALWAYS_IGNORED = [".git", "**/node_modules"];
const IGNORED_DIRECTORY_LIMIT = 4_096;
const IGNORED_LISTING_BYTES = 1024 * 1024;
const CREATED_PATH_PROBES = 32;
const IGNORE_RECHECK_DELAY_MS = 2_000;
const IGNORE_RECHECK_INTERVAL_MS = 10_000;
const RETRY_START_MS = 60_000;
const RETRY_LIMIT_MS = 30 * 60 * 1000;

export type WorkingTreeChangeKind = "create" | "delete" | "update";

/** One changed path, relative to the watched root with `/` separators. */
export interface WorkingTreeChange {
    readonly kind: WorkingTreeChangeKind;
    readonly path: string;
}

export interface WorkingTreeObserver {
    /** Changed paths, or `null` when changes may have been missed and everything is suspect. */
    readonly onChanges: (changes: readonly WorkingTreeChange[] | null) => void;
    /** Whether events are currently arriving for this root; polling must cover the gaps. */
    readonly onWatching?: (watching: boolean) => void;
}

interface WatchedRoot {
    readonly observers: Set<WorkingTreeObserver>;
    closed: boolean;
    ignored: readonly string[];
    ignoreCheckedAt: number;
    ignoreTimer: NodeJS.Timeout | undefined;
    retryDelayMs: number;
    retryTimer: NodeJS.Timeout | undefined;
    readonly root: string;
    /** Advanced on every subscription attempt so a superseded attempt abandons itself. */
    subscriptionGeneration: number;
    subscription: LiveSubscription | undefined;
    watching: boolean;
}

interface LiveSubscription {
    readonly native: AsyncSubscription;
    /** Cleared when this subscription is replaced or fails, which silences its callback. */
    live: boolean;
}

type ParcelWatcher = typeof import("@parcel/watcher");

/**
 * One native recursive watch per working tree, shared by every observer of that folder.
 *
 * `@parcel/watcher` uses Watchman when it is installed and otherwise the platform's own recursive
 * watcher: FSEvents, ReadDirectoryChangesW, or inotify. inotify has no recursive mode, so on Linux
 * each directory costs one kernel watch from a per-user budget. Git-ignored directories are
 * therefore excluded from the watch itself rather than filtered afterwards, which keeps a
 * checkout at hundreds of watches instead of the tens of thousands `node_modules` alone can hold.
 * The ignore list is re-derived when `.gitignore` changes or new directories appear, so build
 * output created later drops out as soon as Git calls it ignored.
 *
 * A root that cannot be watched — an exhausted inotify budget, a filesystem without events, a
 * folder that does not exist yet — reports `watching: false`, and its observers keep polling.
 */
export class WorkingTreeWatcher {
    readonly #ctx: Context;
    readonly #roots = new Map<string, WatchedRoot>();
    readonly #scan: ScanGitRunner;
    #disposed = false;
    #parcel: Promise<ParcelWatcher> | undefined;

    constructor(rootContext: RootContext, scan: ScanGitRunner) {
        this.#ctx = rootContext.named("git-working-tree-watcher");
        this.#scan = scan;
        this.#ctx.lifetime?.addEventListener("abort", () => this.dispose(), { once: true });
    }

    /** Whether events are currently arriving for `root`. */
    isWatching(root: string): boolean {
        return this.#roots.get(resolve(root))?.watching === true;
    }

    watch(root: string, observer: WorkingTreeObserver): () => void {
        if (this.#disposed) return () => undefined;
        const path = resolve(root);
        let entry = this.#roots.get(path);
        if (entry === undefined) {
            entry = {
                closed: false,
                ignoreCheckedAt: 0,
                ignoreTimer: undefined,
                ignored: [],
                observers: new Set(),
                retryDelayMs: RETRY_START_MS,
                retryTimer: undefined,
                root: path,
                subscription: undefined,
                subscriptionGeneration: 0,
                watching: false,
            };
            this.#roots.set(path, entry);
            void this.#subscribe(entry);
        }
        entry.observers.add(observer);
        if (entry.watching) observer.onWatching?.(true);
        const watched = entry;
        let released = false;
        return () => {
            if (released) return;
            released = true;
            watched.observers.delete(observer);
            if (watched.observers.size === 0) this.#close(watched);
        };
    }

    dispose(): void {
        if (this.#disposed) return;
        this.#disposed = true;
        for (const entry of Array.from(this.#roots.values())) this.#close(entry);
    }

    async #subscribe(entry: WatchedRoot): Promise<void> {
        const generation = ++entry.subscriptionGeneration;
        const ignored = await this.#ignoredDirectories(entry.root);
        if (entry.closed || generation !== entry.subscriptionGeneration) return;
        entry.ignored = ignored;
        entry.ignoreCheckedAt = Date.now();
        // Events flow as soon as the native watch exists, even while an older one is still open.
        const handle = { live: true };
        let native: AsyncSubscription;
        try {
            const parcel = await this.#loadParcel();
            native = await parcel.subscribe(
                entry.root,
                (error, events) => {
                    if (entry.closed || !handle.live) return;
                    if (error !== null) {
                        this.#failed(entry, error, true);
                        return;
                    }
                    this.#deliver(entry, events);
                },
                { ignore: [...ALWAYS_IGNORED, ...ignored.map((path) => join(entry.root, path))] },
            );
        } catch (error) {
            if (entry.closed || generation !== entry.subscriptionGeneration) return;
            // A narrower replacement that could not start leaves the working watch in place.
            if (entry.subscription !== undefined) return;
            this.#failed(entry, error, false);
            return;
        }
        if (entry.closed || generation !== entry.subscriptionGeneration) {
            handle.live = false;
            await native.unsubscribe().catch(() => undefined);
            return;
        }
        // The replacement is live before the previous watch closes, so a re-derived ignore list
        // never opens a window in which changes go unseen.
        const previous = entry.subscription;
        entry.subscription = Object.assign(handle, { native });
        entry.retryDelayMs = RETRY_START_MS;
        if (previous !== undefined) {
            previous.live = false;
            await previous.native.unsubscribe().catch(() => undefined);
        }
        if (!entry.watching) {
            entry.watching = true;
            for (const observer of Array.from(entry.observers)) observer.onWatching?.(true);
        }
    }

    #deliver(entry: WatchedRoot, events: readonly Event[]): void {
        const changes: WorkingTreeChange[] = [];
        const created: string[] = [];
        let ignoreRulesChanged = false;
        for (const event of events) {
            const path = relativePath(entry.root, event.path);
            if (path === undefined || path === ".git" || path.startsWith(".git/")) continue;
            changes.push({ kind: event.type, path });
            if (basename(path) === ".gitignore") ignoreRulesChanged = true;
            else if (event.type === "create") created.push(event.path);
        }
        if (changes.length === 0) return;
        for (const observer of Array.from(entry.observers)) observer.onChanges(changes);
        if (ignoreRulesChanged) this.#scheduleIgnoreCheck(entry);
        else if (created.length > 0) void this.#checkCreated(entry, created);
    }

    /** A new directory may be build output Git ignores, which must not stay watched. */
    async #checkCreated(entry: WatchedRoot, paths: readonly string[]): Promise<void> {
        if (entry.ignoreTimer !== undefined) return;
        for (const path of paths.slice(0, CREATED_PATH_PROBES)) {
            try {
                if ((await lstat(path)).isDirectory()) {
                    this.#scheduleIgnoreCheck(entry);
                    return;
                }
            } catch {
                // Already gone; nothing is watching it any more either.
            }
        }
    }

    #scheduleIgnoreCheck(entry: WatchedRoot): void {
        if (entry.closed || entry.ignoreTimer !== undefined) return;
        const delay = Math.max(
            IGNORE_RECHECK_DELAY_MS,
            entry.ignoreCheckedAt + IGNORE_RECHECK_INTERVAL_MS - Date.now(),
        );
        entry.ignoreTimer = setTimeout(() => {
            entry.ignoreTimer = undefined;
            void this.#recheckIgnores(entry);
        }, delay);
        entry.ignoreTimer.unref?.();
    }

    async #recheckIgnores(entry: WatchedRoot): Promise<void> {
        if (entry.closed || !entry.watching) return;
        const ignored = await this.#ignoredDirectories(entry.root);
        entry.ignoreCheckedAt = Date.now();
        if (entry.closed || sameList(ignored, entry.ignored)) return;
        await this.#subscribe(entry);
    }

    #failed(entry: WatchedRoot, error: unknown, wasWatching: boolean): void {
        this.#ctx.log.debug(
            "A working tree could not be watched; its changes will be polled.",
            { path: entry.root },
            error,
        );
        const subscription = entry.subscription;
        entry.subscription = undefined;
        entry.subscriptionGeneration += 1;
        if (subscription !== undefined) {
            subscription.live = false;
            void subscription.native.unsubscribe().catch(() => undefined);
        }
        if (entry.watching) {
            entry.watching = false;
            for (const observer of Array.from(entry.observers)) {
                observer.onWatching?.(false);
                // Events between the failure and now are unknown.
                if (wasWatching) observer.onChanges(null);
            }
        }
        if (entry.retryTimer !== undefined) return;
        const delay = entry.retryDelayMs;
        entry.retryDelayMs = Math.min(RETRY_LIMIT_MS, entry.retryDelayMs * 2);
        entry.retryTimer = setTimeout(() => {
            entry.retryTimer = undefined;
            if (!entry.closed) void this.#subscribe(entry);
        }, delay);
        entry.retryTimer.unref?.();
    }

    #close(entry: WatchedRoot): void {
        if (entry.closed) return;
        entry.closed = true;
        entry.subscriptionGeneration += 1;
        if (entry.ignoreTimer !== undefined) clearTimeout(entry.ignoreTimer);
        if (entry.retryTimer !== undefined) clearTimeout(entry.retryTimer);
        if (entry.subscription !== undefined) {
            entry.subscription.live = false;
            void entry.subscription.native.unsubscribe().catch(() => undefined);
        }
        entry.subscription = undefined;
        entry.observers.clear();
        if (this.#roots.get(entry.root) === entry) this.#roots.delete(entry.root);
    }

    /**
     * Every directory Git ignores, as Git itself decides, through the hardened read-only runner.
     * `--directory` reports an ignored directory once instead of descending into it. A folder
     * that is not a repository ignores nothing beyond the fixed list.
     */
    async #ignoredDirectories(root: string): Promise<readonly string[]> {
        try {
            const result = await this.#scan({
                args: [
                    "ls-files",
                    "-z",
                    "--others",
                    "--ignored",
                    "--exclude-standard",
                    "--directory",
                ],
                cwd: root,
                maximumBytes: IGNORED_LISTING_BYTES,
            });
            const directories = result.stdout
                .split("\0")
                .filter((entry) => entry.endsWith("/"))
                .map((entry) => entry.slice(0, -1))
                .filter((entry) => entry.length > 0 && !entry.split("/").includes(".."));
            return directories.sort().slice(0, IGNORED_DIRECTORY_LIMIT);
        } catch {
            return [];
        }
    }

    async #loadParcel(): Promise<ParcelWatcher> {
        this.#parcel ??= import("@parcel/watcher").then(
            (loaded) => (loaded as ParcelWatcher & { default?: ParcelWatcher }).default ?? loaded,
        );
        return await this.#parcel;
    }
}

function relativePath(root: string, path: string): string | undefined {
    const value = relative(root, path);
    if (value.length === 0 || value.startsWith("..") || isAbsolute(value)) return undefined;
    return sep === "/" ? value : value.split(sep).join("/");
}

function sameList(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((value, index) => value === right[index]);
}
