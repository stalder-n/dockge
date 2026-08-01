import * as fs from "node:fs";
import * as http from "node:http";
import * as https from "node:https";
import * as os from "node:os";
import path from "path";
import { URL } from "node:url";
import dotenv from "dotenv";
import yaml from "yaml";
import * as childProcessAsync from "promisify-child-process";
import { envsubstYAML } from "../common/util-common";
import { log } from "./log";
import { Settings } from "./settings";
import { Stack } from "./stack";
import type { DockgeServer } from "./dockge-server";

/** Default polling interval in hours */
export const DEFAULT_IMAGE_UPDATE_INTERVAL_HOURS = 6;

/** Min/max clamp for the polling interval setting */
export const MIN_IMAGE_UPDATE_INTERVAL_HOURS = 1;
export const MAX_IMAGE_UPDATE_INTERVAL_HOURS = 168;

/** Concurrent registry/distribution checks */
const CHECK_CONCURRENCY = 4;

/** Deadline for the local `docker image inspect` child process */
const LOCAL_INSPECT_TIMEOUT_MS = 30_000;

export type ImageUpdateServiceStatus = "up-to-date" | "update-available" | "unknown" | "error";

export type StackUpdateCheckStatus = "ok" | "unknown" | "error" | "pending";

export interface ServiceUpdateInfo {
    name: string;
    image: string;
    status: ImageUpdateServiceStatus;
}

export interface StackUpdateCacheEntry {
    updateAvailable: boolean;
    updateCheckStatus: StackUpdateCheckStatus;
    updateServices: string[];
    services: ServiceUpdateInfo[];
    checkedAt: number;
}

export interface StackUpdateFields {
    updateAvailable: boolean;
    updateCheckStatus: StackUpdateCheckStatus;
    updateServices: string[];
}

interface ParsedImageRef {
    /** Name as used by Docker Engine / CLI (includes tag) */
    reference: string;
    registry: string;
    repository: string;
    tag: string;
}

interface DockerAuthConfig {
    auths?: Record<string, { auth?: string; username?: string; password?: string }>;
}

/**
 * Compare local RepoDigests against a remote registry digest.
 * @param localRepoDigests Entries like `repo@sha256:…`
 * @param remoteDigest Digest like `sha256:…`
 * @returns True when the remote digest is not present locally
 */
function imageNeedsUpdate(localRepoDigests: string[], remoteDigest: string): boolean {
    if (!remoteDigest) {
        return false;
    }
    const normalized = remoteDigest.startsWith("sha256:") ? remoteDigest : `sha256:${remoteDigest}`;
    for (const entry of localRepoDigests) {
        const at = entry.lastIndexOf("@");
        if (at >= 0 && entry.slice(at + 1) === normalized) {
            return false;
        }
    }
    return true;
}

/**
 * Parse a compose `image:` string into registry / repository / tag parts.
 * Digest-pinned refs (`@sha256:`) should be filtered before calling this.
 * @param image Image reference from compose
 * @returns Parsed parts
 */
function parseImageRef(image: string): ParsedImageRef {
    let tag = "latest";
    let nameWithoutTag = image.trim();

    const lastColon = nameWithoutTag.lastIndexOf(":");
    const lastSlash = nameWithoutTag.lastIndexOf("/");
    if (lastColon > lastSlash) {
        tag = nameWithoutTag.slice(lastColon + 1);
        nameWithoutTag = nameWithoutTag.slice(0, lastColon);
    }

    const parts = nameWithoutTag.split("/");
    let registry = "docker.io";
    let repository: string;

    if (parts.length === 1) {
        repository = `library/${parts[0]}`;
    } else if (parts[0].includes(".") || parts[0].includes(":") || parts[0] === "localhost") {
        registry = parts[0];
        repository = parts.slice(1).join("/");
    } else {
        repository = nameWithoutTag;
    }

    const reference = image.includes(":") && lastColon > lastSlash ? image.trim() : `${nameWithoutTag}:latest`;

    return {
        reference,
        registry,
        repository,
        tag,
    };
}

/**
 * Run async work over items with a concurrency limit.
 * @param items Items to process
 * @param concurrency Max parallel workers
 * @param fn Async mapper
 * @returns Results in input order
 */
async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let next = 0;

    const worker = async () => {
        while (next < items.length) {
            const index = next++;
            results[index] = await fn(items[index]);
        }
    };

    const workers = Array.from({ length: Math.min(concurrency, Math.max(items.length, 1)) }, () => worker());
    await Promise.all(workers);
    return results;
}

/**
 * Background digest-based image update checker (Arcane / Watchtower style).
 * Results are cached in memory and merged into stackList pushes.
 */
export class ImageUpdateChecker {
    private server: DockgeServer | null = null;
    private cache = new Map<string, StackUpdateCacheEntry>();
    private checking = false;
    private pendingForceRefresh = false;
    private timer: NodeJS.Timeout | null = null;
    private initialTimer: NodeJS.Timeout | null = null;
    private remoteDigestCache = new Map<string, { digest: string; expires: number }>();
    /** Bumped when a stack check starts; stale concurrent writers skip cache commits. */
    private stackCheckGeneration = new Map<string, number>();

    /**
     * Bind to the running server and start the polling loop.
     * @param server Dockge server instance
     */
    start(server: DockgeServer) {
        this.server = server;
        void this.reschedule();
        // Initial scan shortly after boot so the UI is not empty
        this.initialTimer = setTimeout(async () => {
            this.initialTimer = null;
            try {
                if (!(await this.isEnabled())) {
                    return;
                }
                await this.checkAllStacks();
                await server.sendStackList();
            } catch (e) {
                // A failing boot scan (e.g. the daemon is not up yet) must not reject unhandled
                log.error("image-update", e);
            }
        }, 15_000);
    }

    /**
     * Stop timers (shutdown).
     */
    stop() {
        if (this.initialTimer) {
            clearTimeout(this.initialTimer);
            this.initialTimer = null;
        }
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }
    }

    /**
     * Reload interval from settings and restart the timer.
     */
    async reschedule() {
        if (this.timer) {
            clearTimeout(this.timer);
            this.timer = null;
        }

        const enabled = await this.isEnabled();
        if (!enabled) {
            // Checks that already passed the isEnabled() gate must not repopulate the cache
            // after it is cleared, or their indicators would stick around with no timer left.
            this.invalidateInFlightChecks();
            this.cache.clear();
            this.remoteDigestCache.clear();
            log.info("image-update", "Image update checking is disabled");
            if (this.server) {
                void this.server.sendStackList();
            }
            return;
        }

        const hours = await this.getIntervalHours();
        const ms = hours * 60 * 60 * 1000;
        log.info("image-update", `Scheduling image update checks every ${hours}h`);

        this.timer = setTimeout(async () => {
            try {
                await this.checkAllStacks();
                if (this.server) {
                    await this.server.sendStackList();
                }
            } catch (e) {
                log.error("image-update", e);
            } finally {
                await this.reschedule();
            }
        }, ms);
    }

    /**
     * Whether polling is enabled (default true).
     * @returns Enabled flag
     */
    async isEnabled(): Promise<boolean> {
        const value = await Settings.get("imageUpdateCheckEnabled");
        if (value === undefined || value === null) {
            return true;
        }
        return value !== false;
    }

    /**
     * Polling interval in hours (clamped).
     * @returns Interval hours
     */
    async getIntervalHours(): Promise<number> {
        const value = await Settings.get("imageUpdateCheckIntervalHours");
        const hours = typeof value === "number" ? value : Number(value);
        if (!Number.isFinite(hours)) {
            return DEFAULT_IMAGE_UPDATE_INTERVAL_HOURS;
        }
        return Math.min(MAX_IMAGE_UPDATE_INTERVAL_HOURS, Math.max(MIN_IMAGE_UPDATE_INTERVAL_HOURS, hours));
    }

    /**
     * Fields to merge into a stackList entry.
     * @param stackName Stack name
     * @returns Update indication fields
     */
    getStackUpdateFields(stackName: string): StackUpdateFields {
        const entry = this.cache.get(stackName);
        if (!entry) {
            return {
                updateAvailable: false,
                updateCheckStatus: "pending",
                updateServices: [],
            };
        }
        return {
            updateAvailable: entry.updateAvailable,
            updateCheckStatus: entry.updateCheckStatus,
            updateServices: entry.updateServices,
        };
    }

    /**
     * Drop cached result for a stack (e.g. after update/deploy/delete).
     * @param stackName Stack name
     */
    invalidate(stackName: string) {
        this.cache.delete(stackName);
        this.beginStackCheck(stackName);
        log.debug("image-update", `Invalidated cache for stack ${stackName}`);
    }

    /**
     * Bump the per-stack check generation so older in-flight writers discard their result.
     * @param stackName Stack name
     * @returns New generation for this check
     */
    private beginStackCheck(stackName: string): number {
        const gen = (this.stackCheckGeneration.get(stackName) ?? 0) + 1;
        this.stackCheckGeneration.set(stackName, gen);
        return gen;
    }

    /**
     * Bump every known stack generation so all outstanding checks discard their results.
     */
    private invalidateInFlightChecks() {
        for (const [ name, gen ] of this.stackCheckGeneration) {
            this.stackCheckGeneration.set(name, gen + 1);
        }
    }

    /**
     * Write a stack cache entry only if this check is still the latest for the stack.
     * @param stackName Stack name
     * @param gen Generation captured at check start
     * @param entry Cache entry
     */
    private commitStackCache(stackName: string, gen: number, entry: StackUpdateCacheEntry) {
        if (this.stackCheckGeneration.get(stackName) !== gen) {
            return;
        }
        this.cache.set(stackName, entry);
    }

    /**
     * Scan every managed stack.
     * @param forceRefresh When true, clear the remote digest cache before scanning (manual / post-op checks)
     */
    async checkAllStacks(forceRefresh = false) {
        if (!this.server) {
            return;
        }

        if (this.checking) {
            if (forceRefresh) {
                this.pendingForceRefresh = true;
            }
            return;
        }

        let force = forceRefresh;
        do {
            if (force) {
                this.remoteDigestCache.clear();
            }

            this.checking = true;
            log.info("image-update", "Checking stacks for image updates");

            try {
                const stackList = await Stack.getStackList(this.server, false);
                const managed = [ ...stackList.values() ].filter((s) => s.isManagedByDockge);

                await mapPool(managed, 2, async (stack) => {
                    await this.checkStackInstance(stack);
                });

                log.info("image-update", `Finished checking ${managed.length} stacks`);
            } finally {
                this.checking = false;
            }

            force = this.pendingForceRefresh;
            this.pendingForceRefresh = false;
        } while (force);
    }

    /**
     * Check a single stack by name (clears remote digest cache for a fresh fetch).
     * @param stackName Stack name
     */
    async checkOneStack(stackName: string) {
        if (!this.server) {
            return;
        }

        this.remoteDigestCache.clear();

        const gen = this.beginStackCheck(stackName);
        this.commitStackCache(stackName, gen, {
            updateAvailable: false,
            updateCheckStatus: "pending",
            updateServices: [],
            services: [],
            checkedAt: Date.now(),
        });

        try {
            const stack = await Stack.getStack(this.server, stackName);
            await this.checkStackInstance(stack, gen);
        } catch (e) {
            log.warn("image-update", `Failed checking stack ${stackName}: ${e instanceof Error ? e.message : e}`);
            this.commitStackCache(stackName, gen, {
                updateAvailable: false,
                updateCheckStatus: "error",
                updateServices: [],
                services: [],
                checkedAt: Date.now(),
            });
        }
    }

    /**
     * Inspect one stack's compose images and compare digests.
     * @param stack Stack instance (may be a list snapshot; re-fetched unless `existingGen` is set)
     * @param existingGen Optional generation from an outer caller (e.g. pending check with a fresh Stack)
     */
    private async checkStackInstance(stack: Stack, existingGen?: number) {
        const gen = existingGen ?? this.beginStackCheck(stack.name);

        try {
            // Bulk scans pass list snapshots; re-load so a concurrent post-op check is not
            // overwritten by stale compose/image state from the start of the full scan.
            let current = stack;
            if (existingGen === undefined && this.server) {
                current = await Stack.getStack(this.server, stack.name);
            }

            if (!current.isManagedByDockge) {
                this.commitStackCache(current.name, gen, {
                    updateAvailable: false,
                    updateCheckStatus: "ok",
                    updateServices: [],
                    services: [],
                    checkedAt: Date.now(),
                });
                return;
            }

            const services = this.collectServiceImages(current);
            if (services.length === 0) {
                this.commitStackCache(current.name, gen, {
                    updateAvailable: false,
                    updateCheckStatus: "ok",
                    updateServices: [],
                    services: [],
                    checkedAt: Date.now(),
                });
                return;
            }

            const results = await mapPool(services, CHECK_CONCURRENCY, async (svc) => {
                return await this.checkServiceImage(svc.name, svc.image);
            });

            const updateServices = results.filter((r) => r.status === "update-available").map((r) => r.name);
            let updateCheckStatus: StackUpdateCheckStatus = "ok";
            if (results.some((r) => r.status === "error")) {
                updateCheckStatus = "error";
            } else if (results.some((r) => r.status === "unknown")) {
                updateCheckStatus = "unknown";
            }

            this.commitStackCache(current.name, gen, {
                updateAvailable: updateServices.length > 0,
                updateCheckStatus,
                updateServices,
                services: results,
                checkedAt: Date.now(),
            });
        } catch (e) {
            log.warn("image-update", `Failed checking stack ${stack.name}: ${e instanceof Error ? e.message : e}`);
            this.commitStackCache(stack.name, gen, {
                updateAvailable: false,
                updateCheckStatus: "error",
                updateServices: [],
                services: [],
                checkedAt: Date.now(),
            });
        }
    }

    /**
     * Parse compose YAML into checkable service image refs.
     * @param stack Stack
     * @returns Service name + image pairs
     */
    private collectServiceImages(stack: Stack): { name: string; image: string }[] {
        const env: Record<string, string> = {};

        if (!this.server) {
            return [];
        }

        const globalEnvPath = path.join(this.server.stacksDir, "global.env");
        if (fs.existsSync(globalEnvPath)) {
            Object.assign(env, dotenv.parse(fs.readFileSync(globalEnvPath, "utf-8")));
        }
        Object.assign(env, dotenv.parse(stack.composeENV));
        // Compose gives shell variables precedence over --env-file values, and the compose
        // PTY inherits this process's environment, so it wins here too.
        for (const [ key, value ] of Object.entries(process.env)) {
            if (typeof value === "string") {
                env[key] = value;
            }
        }

        let substituted: string;
        try {
            substituted = envsubstYAML(stack.composeYAML, env);
        } catch (e) {
            log.warn("image-update", `envsubst failed for ${stack.name}: ${e instanceof Error ? e.message : e}`);
            substituted = stack.composeYAML;
        }

        let doc: unknown;
        try {
            doc = yaml.parse(substituted);
        } catch (e) {
            log.warn("image-update", `YAML parse failed for ${stack.name}: ${e instanceof Error ? e.message : e}`);
            return [];
        }

        if (!doc || typeof doc !== "object") {
            return [];
        }

        const services = (doc as { services?: Record<string, unknown> }).services;
        if (!services || typeof services !== "object") {
            return [];
        }

        const result: { name: string; image: string }[] = [];

        for (const [ name, raw ] of Object.entries(services)) {
            if (!raw || typeof raw !== "object") {
                continue;
            }
            const service = raw as { image?: unknown; build?: unknown };
            if (service.build && !service.image) {
                continue;
            }
            if (typeof service.image !== "string" || service.image.trim() === "") {
                continue;
            }
            const image = service.image.trim();
            if (image.includes("@sha256:")) {
                continue;
            }
            result.push({
                name,
                image,
            });
        }

        return result;
    }

    /**
     * Check a single image ref for updates.
     * @param serviceName Compose service name
     * @param image Image reference
     * @returns Service update info
     */
    private async checkServiceImage(serviceName: string, image: string): Promise<ServiceUpdateInfo> {
        try {
            const parsed = parseImageRef(image);
            const localDigests = await this.getLocalRepoDigests(parsed.reference);

            if (localDigests.length === 0) {
                return {
                    name: serviceName,
                    image: parsed.reference,
                    status: "unknown",
                };
            }

            const remoteDigest = await this.getRemoteDigest(parsed);
            if (!remoteDigest) {
                return {
                    name: serviceName,
                    image: parsed.reference,
                    status: "unknown",
                };
            }

            const needs = imageNeedsUpdate(localDigests, remoteDigest);
            return {
                name: serviceName,
                image: parsed.reference,
                status: needs ? "update-available" : "up-to-date",
            };
        } catch (e) {
            log.debug("image-update", `Error checking ${image}: ${e instanceof Error ? e.message : e}`);
            return {
                name: serviceName,
                image,
                status: "error",
            };
        }
    }

    /**
     * Local RepoDigests via `docker image inspect`.
     * @param reference Image reference
     * @returns RepoDigest strings
     */
    private async getLocalRepoDigests(reference: string): Promise<string[]> {
        try {
            const res = await childProcessAsync.spawn(
                "docker",
                [ "image", "inspect", reference, "--format", "{{json .RepoDigests}}" ],
                {
                    encoding: "utf-8",
                    // An unresponsive daemon would otherwise keep the child (and the scan) pending forever
                    timeout: LOCAL_INSPECT_TIMEOUT_MS,
                    killSignal: "SIGKILL",
                },
            );
            if (!res.stdout) {
                return [];
            }
            const parsed = JSON.parse(res.stdout.toString()) as unknown;
            if (!Array.isArray(parsed)) {
                return [];
            }
            return parsed.filter((d): d is string => typeof d === "string");
        } catch {
            return [];
        }
    }

    /**
     * Resolve remote digest: Engine Distribution API first, Registry HTTP fallback.
     * @param parsed Parsed image ref
     * @returns Digest or null
     */
    private async getRemoteDigest(parsed: ParsedImageRef): Promise<string | null> {
        const cacheKey = parsed.reference;
        const cached = this.remoteDigestCache.get(cacheKey);
        if (cached && cached.expires > Date.now()) {
            return cached.digest;
        }

        let digest = await this.fetchDigestViaDistribution(parsed.reference);
        if (!digest) {
            digest = await this.fetchDigestViaRegistryHttp(parsed);
        }

        if (digest) {
            // Cap cache size to avoid unbounded growth across many tags
            if (this.remoteDigestCache.size > 500) {
                const oldest = this.remoteDigestCache.keys().next().value;
                if (oldest !== undefined) {
                    this.remoteDigestCache.delete(oldest);
                }
            }
            this.remoteDigestCache.set(cacheKey, {
                digest,
                expires: Date.now() + 5 * 60 * 1000,
            });
        }

        return digest;
    }

    /**
     * GET /distribution/{name}/json via the Docker engine socket/TCP.
     * @param reference Image reference
     * @returns Digest or null
     */
    private async fetchDigestViaDistribution(reference: string): Promise<string | null> {
        try {
            const encoded = reference.split("/").map(encodeURIComponent).join("/");
            const response = await this.dockerEngineRequest(`/distribution/${encoded}/json`);
            if (response.statusCode !== 200) {
                return null;
            }
            const body = JSON.parse(response.body) as { Descriptor?: { Digest?: string } };
            return body.Descriptor?.Digest ?? null;
        } catch (e) {
            log.debug("image-update", `DistributionInspect failed for ${reference}: ${e instanceof Error ? e.message : e}`);
            return null;
        }
    }

    /**
     * Registry HTTP v2 manifest digest (Docker Hub / OCI / private with config.json auth).
     * @param parsed Parsed image ref
     * @returns Digest or null
     */
    private async fetchDigestViaRegistryHttp(parsed: ParsedImageRef): Promise<string | null> {
        try {
            const registryHost = parsed.registry === "docker.io" ? "registry-1.docker.io" : parsed.registry;
            const manifestPath = `/v2/${parsed.repository}/manifests/${encodeURIComponent(parsed.tag)}`;
            const accept = [
                "application/vnd.oci.image.index.v1+json",
                "application/vnd.docker.distribution.manifest.list.v2+json",
                "application/vnd.oci.image.manifest.v1+json",
                "application/vnd.docker.distribution.manifest.v2+json",
                "application/vnd.docker.distribution.manifest.v1+prettyjws",
            ].join(", ");

            let headers: Record<string, string> = { Accept: accept };
            const basicAuth = this.getDockerConfigBasicAuth(parsed.registry);
            if (basicAuth) {
                headers.Authorization = `Basic ${basicAuth}`;
            }

            const manifestUrl = `https://${registryHost}${manifestPath}`;
            let response = await this.requestManifest(manifestUrl, "HEAD", headers, accept, parsed.repository, basicAuth);
            headers = response.headersOut;

            if (response.statusCode !== 200) {
                // Some registries reject HEAD; retry GET (and auth if the GET challenges)
                response = await this.requestManifest(manifestUrl, "GET", headers, accept, parsed.repository, basicAuth);
            }

            if (response.statusCode !== 200) {
                return null;
            }

            const digest =
                response.headers["docker-content-digest"] ||
                response.headers["oci-content-digest"];
            if (typeof digest === "string") {
                return digest;
            }
            if (Array.isArray(digest) && digest[0]) {
                return digest[0];
            }
            return null;
        } catch (e) {
            log.debug("image-update", `Registry HTTP failed for ${parsed.reference}: ${e instanceof Error ? e.message : e}`);
            return null;
        }
    }

    /**
     * Manifest request with one Bearer-token retry on 401/403.
     * @param url Absolute manifest URL
     * @param method HEAD or GET
     * @param headers Request headers
     * @param accept Accept header value (for rebuilding after token auth)
     * @param repository Repository path for the token scope
     * @param basicAuth Optional basic auth for the token request
     * @returns Status, response headers, and possibly updated request headers
     */
    private async requestManifest(
        url: string,
        method: "HEAD" | "GET",
        headers: Record<string, string>,
        accept: string,
        repository: string,
        basicAuth: string | undefined,
    ): Promise<{
        statusCode: number;
        headers: http.IncomingHttpHeaders;
        headersOut: Record<string, string>;
    }> {
        // Digest comes from response headers; do not retain unused GET bodies.
        const requestOpts = { collectBody: false };
        let response = await this.httpsRequest(url, method, headers, requestOpts);
        let headersOut = headers;

        if (response.statusCode === 401 || response.statusCode === 403) {
            const wwwAuth = response.headers["www-authenticate"];
            const token = await this.fetchRegistryToken(wwwAuth, repository, basicAuth);
            if (token) {
                headersOut = {
                    Accept: accept,
                    Authorization: `Bearer ${token}`,
                };
                response = await this.httpsRequest(url, method, headersOut, requestOpts);
            }
        }

        return {
            statusCode: response.statusCode,
            headers: response.headers,
            headersOut,
        };
    }

    /**
     * Resolve a Bearer token from a WWW-Authenticate challenge.
     * @param wwwAuth Header value
     * @param repository Repository path
     * @param basicAuth Optional base64 user:pass for the token request
     * @returns Token or null
     */
    private async fetchRegistryToken(
        wwwAuth: string | string[] | undefined,
        repository: string,
        basicAuth?: string,
    ): Promise<string | null> {
        const header = Array.isArray(wwwAuth) ? wwwAuth[0] : wwwAuth;
        if (!header || !header.toLowerCase().startsWith("bearer ")) {
            return null;
        }

        const realm = /realm="([^"]+)"/i.exec(header)?.[1];
        const service = /service="([^"]+)"/i.exec(header)?.[1];
        if (!realm) {
            return null;
        }

        const url = new URL(realm);
        if (service) {
            url.searchParams.set("service", service);
        }
        url.searchParams.set("scope", `repository:${repository}:pull`);

        const headers: Record<string, string> = {};
        if (basicAuth) {
            headers.Authorization = `Basic ${basicAuth}`;
        }

        const response = await this.httpsRequest(url.toString(), "GET", headers);
        if (response.statusCode !== 200) {
            return null;
        }

        try {
            const body = JSON.parse(response.body) as { token?: string; access_token?: string };
            return body.token || body.access_token || null;
        } catch {
            return null;
        }
    }

    /**
     * Read base64 `auth` from Docker config.json for a registry.
     * @param registry Registry host (docker.io for Hub)
     * @returns Base64 auth blob or undefined
     */
    private getDockerConfigBasicAuth(registry: string): string | undefined {
        const configDir = process.env.DOCKER_CONFIG || path.join(os.homedir(), ".docker");
        const configPath = path.join(configDir, "config.json");
        if (!fs.existsSync(configPath)) {
            return undefined;
        }

        let config: DockerAuthConfig;
        try {
            config = JSON.parse(fs.readFileSync(configPath, "utf-8")) as DockerAuthConfig;
        } catch {
            return undefined;
        }

        if (!config.auths) {
            return undefined;
        }

        const candidates =
            registry === "docker.io"
                ? [ "https://index.docker.io/v1/", "index.docker.io", "docker.io", "registry-1.docker.io" ]
                : [ registry, `https://${registry}`, `http://${registry}` ];

        for (const key of candidates) {
            const entry = config.auths[key];
            if (entry?.auth) {
                return entry.auth;
            }
            if (entry?.username && entry?.password) {
                return Buffer.from(`${entry.username}:${entry.password}`).toString("base64");
            }
        }

        return undefined;
    }

    /**
     * HTTP(S) request helper returning status, headers, and body text.
     * Caps retained bodies and rejects on truncated/aborted responses so scans cannot hang.
     * The 20s socket timeout only covers inactivity, so an absolute deadline bounds
     * responses that keep trickling data forever.
     * @param url Absolute URL
     * @param method HTTP method
     * @param headers Request headers
     * @param options collectBody (default true), maxBodyBytes (default 64 KiB), deadlineMs (default 30s)
     * @returns Response parts
     */
    private httpsRequest(
        url: string,
        method: string,
        headers: Record<string, string>,
        options: { collectBody?: boolean; maxBodyBytes?: number; deadlineMs?: number } = {},
    ): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
        const collectBody = options.collectBody !== false;
        const maxBodyBytes = options.maxBodyBytes ?? 64 * 1024;
        const deadlineMs = options.deadlineMs ?? 30_000;

        return new Promise((resolve, reject) => {
            const parsed = new URL(url);
            const lib = parsed.protocol === "http:" ? http : https;
            let settled = false;
            let deadline: NodeJS.Timeout | null = null;
            const settle = (fn: () => void) => {
                if (settled) {
                    return;
                }
                settled = true;
                if (deadline) {
                    clearTimeout(deadline);
                    deadline = null;
                }
                fn();
            };

            const req = lib.request(
                {
                    protocol: parsed.protocol,
                    hostname: parsed.hostname,
                    port: parsed.port || undefined,
                    path: parsed.pathname + parsed.search,
                    method,
                    headers,
                    timeout: 20_000,
                },
                (res) => {
                    const fail = (err: Error) => {
                        req.destroy();
                        settle(() => reject(err));
                    };
                    const done = (body: string) => {
                        settle(() => resolve({
                            statusCode: res.statusCode ?? 0,
                            headers: res.headers,
                            body,
                        }));
                    };

                    res.on("aborted", () => fail(new Error("Response aborted")));
                    res.on("error", (err) => fail(err instanceof Error ? err : new Error(String(err))));
                    res.on("close", () => {
                        if (!settled) {
                            fail(new Error("Response closed before complete"));
                        }
                    });

                    if (!collectBody) {
                        // The digest lives in the response headers, so settle as soon as they
                        // arrive and drop the body instead of waiting for `end`.
                        done("");
                        res.destroy();
                    } else {
                        const chunks: Buffer[] = [];
                        let size = 0;
                        res.on("data", (c: Buffer) => {
                            size += c.length;
                            if (size > maxBodyBytes) {
                                fail(new Error("Response body too large"));
                                return;
                            }
                            chunks.push(c);
                        });
                        res.on("end", () => done(Buffer.concat(chunks).toString("utf-8")));
                    }
                },
            );
            req.on("error", (err) => settle(() => reject(err)));
            req.on("timeout", () => {
                req.destroy();
                settle(() => reject(new Error("Request timed out")));
            });
            deadline = setTimeout(() => {
                req.destroy();
                settle(() => reject(new Error("Request exceeded deadline")));
            }, deadlineMs);
            req.end();
        });
    }

    /**
     * Call the Docker Engine HTTP API (unix socket or TCP from DOCKER_HOST).
     * @param apiPath Path beginning with /
     * @returns Response parts
     */
    private dockerEngineRequest(
        apiPath: string,
    ): Promise<{ statusCode: number; headers: http.IncomingHttpHeaders; body: string }> {
        return new Promise((resolve, reject) => {
            const dockerHost = process.env.DOCKER_HOST || "unix:///var/run/docker.sock";
            const options: http.RequestOptions = {
                method: "GET",
                path: apiPath,
                headers: { Host: "localhost" },
                timeout: 20_000,
            };

            if (dockerHost.startsWith("unix://") || dockerHost.startsWith("/")) {
                options.socketPath = dockerHost.replace(/^unix:\/\//, "");
            } else if (dockerHost.startsWith("tcp://")) {
                const u = new URL(dockerHost.replace(/^tcp:\/\//, "http://"));
                options.hostname = u.hostname;
                options.port = u.port || "2375";
            } else {
                options.socketPath = "/var/run/docker.sock";
            }

            const req = http.request(options, (res) => {
                const chunks: Buffer[] = [];
                res.on("data", (c) => chunks.push(c));
                res.on("end", () => {
                    resolve({
                        statusCode: res.statusCode ?? 0,
                        headers: res.headers,
                        body: Buffer.concat(chunks).toString("utf-8"),
                    });
                });
            });
            req.on("error", reject);
            req.on("timeout", () => {
                req.destroy();
                reject(new Error("Docker engine request timed out"));
            });
            req.end();
        });
    }
}

const imageUpdateChecker = new ImageUpdateChecker();
export default imageUpdateChecker;
