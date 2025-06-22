import { exec, spawn } from "child_process";
import { existsSync } from "fs";
import { chmod, mkdir, rmdir, unlink, writeFile } from "fs/promises";
import { join } from "path";
import { promisify } from "util";

const execAsync = promisify(exec);

export interface RefreshTokenResult {
    success: boolean;
    output?: string;
    errorOutput?: string;
    error?: string;
    loginUrl?: string;
}

export async function refreshTokens(): Promise<RefreshTokenResult> {
    console.log("Starting Claude Code login process...");

    // Create temporary directory for mock scripts
    const tempDir = "/tmp/claude-mock-scripts";
    let mockScriptsCreated = false;

    // Define mock scripts to intercept browser opening commands
    const mockScripts = [
        {
            name: "open",
            content: `#!/bin/bash
echo "🔗 INTERCEPTED URL: $1" >&2
echo "$1" > /tmp/claude-intercepted-url.txt
exit 0
`
        },
        {
            name: "xdg-open",
            content: `#!/bin/bash
echo "🔗 INTERCEPTED URL: $1" >&2
echo "$1" > /tmp/claude-intercepted-url.txt
exit 0
`
        }
    ];

    try {
        // Create temporary directory and mock scripts
        if (!existsSync(tempDir)) {
            await mkdir(tempDir, { recursive: true });
        }

        for (const script of mockScripts) {
            const scriptPath = join(tempDir, script.name);
            await writeFile(scriptPath, script.content);
            await chmod(scriptPath, 0o755);
        }
        mockScriptsCreated = true;
        console.log("🔧 Created URL interception scripts");

        // Set up environment with modified PATH
        const env = {
            ...process.env,
            PATH: `${tempDir}:${process.env.PATH}`,
        };

        // Launch Claude Code process
        console.log("🔧 Launching Claude Code with URL interception...");
        const claudeProcess = spawn("claude", [], {
            stdio: ["pipe", "pipe", "pipe"],
            env: env
        });

        let output = "";
        let errorOutput = "";
        let loginUrl = "";
        let menuDisplayed = false;
        let urlDetected = false;

        // Function to check for intercepted URL
        const checkInterceptedUrl = async (): Promise<string | null> => {
            try {
                const { stdout } = await execAsync("cat /tmp/claude-intercepted-url.txt 2>/dev/null || echo ''");
                const url = stdout.trim();
                if (url && url.startsWith("http")) {
                    return url;
                }
            } catch (e) {
                // File doesn't exist yet
            }
            return null;
        };

        // Periodically check for intercepted URL
        const urlCheckInterval = setInterval(async () => {
            if (!urlDetected) {
                const interceptedUrl = await checkInterceptedUrl();
                if (interceptedUrl) {
                    loginUrl = interceptedUrl;
                    urlDetected = true;
                    console.log("🎯 INTERCEPTED BROWSER URL:", interceptedUrl);
                    clearInterval(urlCheckInterval);
                }
            }
        }, 500);

        // Simple menu detection
        const detectMenu = (text: string): boolean => {
            return text.toLowerCase().includes("select login method");
        };

        // Capture stdout
        claudeProcess.stdout.on("data", (data) => {
            const text = data.toString();
            console.log("Claude Output:", text);
            output += text;

            // Check if menu is displayed and send Enter
            if (detectMenu(text) && !menuDisplayed) {
                menuDisplayed = true;
                console.log("🎯 Menu detected - sending Enter key...");
                setTimeout(() => {
                    try {
                        claudeProcess.stdin.write("\n");
                        console.log("✅ Enter key sent");
                    } catch (e) {
                        console.log("Failed to send Enter key:", e);
                    }
                }, 500);
            }
        });

        // Capture stderr
        claudeProcess.stderr.on("data", (data) => {
            const text = data.toString();
            console.log("Claude Error:", text);
            errorOutput += text;
        });

        // Handle process errors
        claudeProcess.on("error", (error) => {
            console.error("Error spawning Claude process:", error);
            throw error;
        });

        // Wait for Claude to initialize
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // Send /login command
        console.log("Sending /login command...");
        claudeProcess.stdin.write("/login\n");

        // Wait for menu detection and processing
        console.log("⏳ Waiting for login menu...");
        let menuProcessed = false;
        const menuStartTime = Date.now();

        while (!menuProcessed && (Date.now() - menuStartTime) < 10000) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            if (menuDisplayed) {
                menuProcessed = true;
                console.log("✅ Menu processed successfully");
                break;
            }
        }

        // Wait for URL to appear
        console.log("⏳ Waiting for authentication URL...");
        await new Promise((resolve) => setTimeout(resolve, 5000));

        // Wait for the process to complete
        const timeoutMs = 120000; // 2 minutes timeout
        const exitCode = await new Promise<number>((resolve, reject) => {
            let resolved = false;

            const timeoutId = setTimeout(() => {
                if (!resolved) {
                    console.error("Claude login process timed out");
                    clearInterval(urlCheckInterval);
                    claudeProcess.kill("SIGTERM");
                    resolved = true;
                    reject(new Error("Login process timed out"));
                }
            }, timeoutMs);

            claudeProcess.on("close", (code) => {
                if (!resolved) {
                    clearTimeout(timeoutId);
                    clearInterval(urlCheckInterval);
                    resolved = true;
                    resolve(code || 0);
                }
            });

            claudeProcess.on("error", (error) => {
                if (!resolved) {
                    clearTimeout(timeoutId);
                    clearInterval(urlCheckInterval);
                    resolved = true;
                    reject(error);
                }
            });
        });

        console.log(`Claude process exited with code: ${exitCode}`);

        // Final check for intercepted URL
        if (!urlDetected) {
            const finalUrl = await checkInterceptedUrl();
            if (finalUrl) {
                loginUrl = finalUrl;
                console.log("🎯 FINAL INTERCEPTED URL:", finalUrl);
            }
        }

        if (exitCode === 0) {
            console.log("✅ Login process completed successfully");
            if (loginUrl) {
                console.log("🔗 Login URL:", loginUrl);
            }
            return { success: true, output, errorOutput, loginUrl };
        } else {
            console.error("❌ Login process failed");
            return { success: false, output, errorOutput, loginUrl };
        }

    } catch (error) {
        console.error("Failed to refresh tokens:", error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        return { success: false, error: errorMessage };
    } finally {
        // Clean up temporary files
        if (mockScriptsCreated) {
            try {
                for (const script of mockScripts) {
                    const scriptPath = join(tempDir, script.name);
                    await unlink(scriptPath).catch(() => { });
                }
                await rmdir(tempDir).catch(() => { });
                console.log("🧹 Cleaned up mock scripts");
            } catch (e) {
                console.log("Warning: Failed to clean up:", e);
            }
        }

        // Clean up intercepted URL file
        await unlink("/tmp/claude-intercepted-url.txt").catch(() => { });
    }
}

// Execute if run directly
if (require.main === module) {
    refreshTokens()
        .then((result) => {
            if (result.success) {
                console.log("✅ Token refresh completed successfully");
                if (result.loginUrl) {
                    console.log("🔗 Login URL:", result.loginUrl);
                }
                process.exit(0);
            } else {
                console.error("❌ Token refresh failed");
                if (result.loginUrl) {
                    console.log("🔗 Login URL was:", result.loginUrl);
                }
                process.exit(1);
            }
        })
        .catch((error) => {
            console.error("❌ Token refresh failed with exception:", error);
            process.exit(1);
        });
} 