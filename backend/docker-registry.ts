import * as fs from "node:fs";
import * as os from "node:os";
import path from "path";
import childProcessAsync from "promisify-child-process";

/** Docker Hub's canonical auth key in config.json */
const DOCKER_HUB_SERVER = "https://index.docker.io/v1/";

export interface DockerRegistryEntry {
    server: string;
    username: string;
}

/**
 * Resolve the Docker CLI config.json path from DOCKER_CONFIG or ~/.docker.
 * @returns Absolute path to config.json
 */
function getDockerConfigPath() : string {
    const configDir = process.env.DOCKER_CONFIG || path.join(os.homedir(), ".docker");
    return path.join(configDir, "config.json");
}

/**
 * Normalize a user-facing registry server to the key Docker stores in config.json.
 * Empty / hub aliases map to Docker Hub's canonical URL.
 * @param registryServer Registry host from the UI, or empty for Docker Hub
 * @returns Normalized registry server string for docker login/logout
 */
function normalizeRegistryServer(registryServer : string) : string {
    const trimmed = registryServer.trim();
    if (trimmed === "" || trimmed === "docker.io" || trimmed === "index.docker.io" || trimmed === DOCKER_HUB_SERVER) {
        return DOCKER_HUB_SERVER;
    }
    return trimmed;
}

/**
 * Extract the username from a Docker config auth entry without exposing the password.
 * @param entry Auth object from config.json (may include base64 `auth`)
 * @returns Username if available, otherwise empty string
 */
function usernameFromAuthEntry(entry : unknown) : string {
    if (!entry || typeof entry !== "object") {
        return "";
    }

    const record = entry as Record<string, unknown>;

    if (typeof record.username === "string" && record.username !== "") {
        return record.username;
    }

    if (typeof record.auth === "string" && record.auth !== "") {
        try {
            const decoded = Buffer.from(record.auth, "base64").toString("utf8");
            const separator = decoded.indexOf(":");
            if (separator > 0) {
                return decoded.slice(0, separator);
            }
        } catch {
            // Ignore malformed auth blobs
        }
    }

    return "";
}

/**
 * List registries that currently have credentials in Docker's config.json.
 * Passwords / tokens are never returned.
 * @returns Registry server and username pairs
 */
export function listRegistries() : DockerRegistryEntry[] {
    const configPath = getDockerConfigPath();
    if (!fs.existsSync(configPath)) {
        return [];
    }

    let config : Record<string, unknown>;
    try {
        config = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
    } catch {
        return [];
    }

    const result = new Map<string, DockerRegistryEntry>();

    const auths = config.auths;
    if (auths && typeof auths === "object") {
        for (const [ server, entry ] of Object.entries(auths as Record<string, unknown>)) {
            result.set(server, {
                server,
                username: usernameFromAuthEntry(entry),
            });
        }
    }

    const credHelpers = config.credHelpers;
    if (credHelpers && typeof credHelpers === "object") {
        for (const server of Object.keys(credHelpers as Record<string, unknown>)) {
            if (!result.has(server)) {
                result.set(server, {
                    server,
                    username: "",
                });
            }
        }
    }

    return Array.from(result.values()).sort((a, b) => a.server.localeCompare(b.server));
}

/**
 * Run a docker CLI auth command; reject with stderr/stdout on non-zero exit.
 * @param args docker CLI arguments after `docker`
 * @param stdinText Optional stdin payload (used for password-stdin)
 * @returns Resolves when the command exits 0
 */
async function runDockerAuthCommand(args : string[], stdinText? : string) : Promise<void> {
    const child = childProcessAsync.spawn("docker", args, {
        encoding: "utf-8",
    });

    if (stdinText !== undefined) {
        child.stdin?.end(stdinText);
    } else {
        child.stdin?.end();
    }

    try {
        await child;
    } catch (e) {
        const err = e as { stderr?: string | Buffer; stdout?: string | Buffer; message?: string };
        const message = (err.stderr || err.stdout || err.message || "Docker auth command failed").toString().trim();
        throw new Error(message);
    }
}

/**
 * Log Docker in to a registry using stdin for the password so it is not exposed in process arguments.
 * @param registryServer Registry host to log in to, or an empty string for Docker Hub
 * @param username Registry username
 * @param password Registry password or access token
 * @returns Resolves when docker login succeeds
 */
export function dockerLogin(registryServer : string, username : string, password : string) : Promise<void> {
    const server = normalizeRegistryServer(registryServer);
    const args = [ "login", "--username", username, "--password-stdin" ];

    // docker login uses no positional arg for Hub; for everything else pass the host/URL.
    if (server !== DOCKER_HUB_SERVER) {
        args.push(server);
    }

    return runDockerAuthCommand(args, `${password}\n`);
}

/**
 * Log Docker out of a registry.
 * @param registryServer Registry host to log out of, or empty / Hub aliases for Docker Hub
 * @returns Resolves when docker logout succeeds
 */
export function dockerLogout(registryServer : string) : Promise<void> {
    const server = normalizeRegistryServer(registryServer);
    const args = [ "logout" ];

    // Match login: omit the server arg for Hub so Docker treats it as the default registry.
    if (server !== DOCKER_HUB_SERVER) {
        args.push(server);
    }

    return runDockerAuthCommand(args);
}
