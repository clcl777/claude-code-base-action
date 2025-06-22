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
# Optionally, you can still open the browser by uncommenting the next line:
# /usr/bin/open "$@"
exit 0
`
        },
        {
            name: "xdg-open",
            content: `#!/bin/bash
echo "🔗 INTERCEPTED URL: $1" >&2
echo "$1" > /tmp/claude-intercepted-url.txt
# Optionally, you can still open the browser by uncommenting the next line:
# /usr/bin/xdg-open "$@"
exit 0
`
        },
        {
            name: "start",
            content: `#!/bin/bash
echo "🔗 INTERCEPTED URL: $1" >&2  
echo "$1" > /tmp/claude-intercepted-url.txt
# Windows start command mock
exit 0
`
        }
    ];

    try {
        // Create temporary directory
        if (!existsSync(tempDir)) {
            await mkdir(tempDir, { recursive: true });
        }

        // Write and make executable the mock scripts
        for (const script of mockScripts) {
            const scriptPath = join(tempDir, script.name);
            await writeFile(scriptPath, script.content);
            await chmod(scriptPath, 0o755);
        }
        mockScriptsCreated = true;
        console.log("🔧 Created mock browser opening scripts in", tempDir);

        // Set environment variables to disable browser auto-opening and force URL display
        const env = {
            ...process.env,
            // Add our mock scripts directory to the beginning of PATH
            PATH: `${tempDir}:${process.env.PATH}`,
            BROWSER: "none",           // Disable browser opening
            NO_BROWSER: "1",           // Alternative way to disable browser
            DISABLE_BROWSER: "1",      // Another way to disable browser
            DISPLAY_URL: "1",          // Force URL display
            CLI_MODE: "1",             // CLI mode to ensure text output
            DEBUG: "1",                // Enable debug mode
            VERBOSE: "1",              // Enable verbose mode
            HEADLESS: "1",             // Headless mode
            CI: "1",                   // Continuous Integration mode (often disables browser)
            NON_INTERACTIVE: "1",      // Non-interactive mode
            TERM: "dumb",              // Simple terminal mode
            DISPLAY: "",               // Clear display (Unix systems)
            BROWSER_DISABLE: "1",      // Another browser disable variant
            NO_OPEN: "1"               // Prevent opening external applications
        };

        // Launch Claude Code process with options to prevent browser opening and increase verbosity
        const claudeArgs: string[] = [];  // No special arguments needed

        console.log("🔧 Launching Claude Code with URL interception...");
        console.log("🔧 Modified PATH:", `${tempDir}:${process.env.PATH?.substring(0, 100)}...`);

        const claudeProcess = spawn("claude", claudeArgs, {
            stdio: ["pipe", "pipe", "pipe"],
            env: env
        });

        let output = "";
        let errorOutput = "";
        let isLoginPrompted = false;
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
                    console.log("🌐 Use this URL for authentication");
                    clearInterval(urlCheckInterval);
                }
            }
        }, 500);

        // Enhanced URL extraction function
        const extractUrl = (text: string): string | null => {
            // Look for various URL patterns
            const urlPatterns = [
                /https?:\/\/[^\s<>"{}|\\^`[\]]+/g,                    // Standard HTTP/HTTPS URLs
                /claude\.ai\/[^\s<>"{}|\\^`[\]]+/g,                  // Claude.ai URLs
                /anthropic\.com\/[^\s<>"{}|\\^`[\]]+/g,              // Anthropic URLs
                /Visit:\s*(https?:\/\/[^\s<>"{}|\\^`[\]]+)/g,       // "Visit: URL" format
                /Open:\s*(https?:\/\/[^\s<>"{}|\\^`[\]]+)/g,        // "Open: URL" format
                /URL:\s*(https?:\/\/[^\s<>"{}|\\^`[\]]+)/g          // "URL: URL" format
            ];

            for (const pattern of urlPatterns) {
                const matches = text.match(pattern);
                if (matches && matches.length > 0) {
                    // Return the first URL found, clean up any prefixes
                    let url = matches[0];
                    url = url.replace(/^(Visit:|Open:|URL:)\s*/i, '');
                    return url;
                }
            }
            return null;
        };

        // Enhanced menu detection for various login method displays
        const detectMenu = (text: string): boolean => {
            const menuIndicators = [
                "Choose an option",
                "Select an option",
                "Select login method",
                "login method",
                "Choose login method",
                "Press Enter",
                "continue",
                "►", "→", ">",
                "1)", "2)", "3)",
                "[Enter]", "(Enter)",
                "to continue",
                "to proceed",
                "OAuth",
                "Browser login"
            ];
            return menuIndicators.some(indicator =>
                text.toLowerCase().includes(indicator.toLowerCase())
            );
        };

        // Function to detect URL-related messages even when browser doesn't open
        const detectUrlMessage = (text: string): boolean => {
            const urlMessages = [
                "visit the following url",
                "go to this url",
                "open this link",
                "navigate to",
                "authentication url",
                "login url",
                "authorization url",
                "complete authentication at"
            ];
            return urlMessages.some(msg =>
                text.toLowerCase().includes(msg.toLowerCase())
            );
        };

        // Capture stdout
        claudeProcess.stdout.on("data", (data) => {
            const text = data.toString();
            console.log("Claude Output:", text);
            output += text;

            // Check if Claude is asking for login
            if (text.includes("login") || text.includes("authentication") || text.includes("Welcome")) {
                isLoginPrompted = true;
            }

            // Extract and log URL if found
            const url = extractUrl(text);
            if (url && !urlDetected) {
                loginUrl = url;
                urlDetected = true;
                console.log("🔗 Login URL detected:", url);
                console.log("🌐 Use this URL for authentication (browser auto-open disabled)");
            }

            // Check for URL-related messages
            if (detectUrlMessage(text)) {
                console.log("🔍 URL message detected - looking for authentication URL...");
            }

            // Check for specific login-related messages
            if (text.includes("Opening browser") || text.includes("Visit this URL")) {
                console.log("📋 Login process initiated - URL should be displayed");
            }

            // Check if menu/choices are displayed
            if (detectMenu(text) && !menuDisplayed) {
                menuDisplayed = true;
                console.log("🎯 Menu/choices detected - sending Enter key...");
                // Send Enter after a short delay to ensure menu is fully displayed
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

            // Also check stderr for URLs (some applications output URLs to stderr)
            const url = extractUrl(text);
            if (url && !urlDetected) {
                loginUrl = url;
                urlDetected = true;
                console.log("🔗 Login URL detected in error stream:", url);
                console.log("🌐 Use this URL for authentication (browser auto-open disabled)");
            }

            // Check for URL-related messages in stderr
            if (detectUrlMessage(text)) {
                console.log("🔍 URL message detected in error stream - looking for authentication URL...");
            }

            // Also check stderr for menu indicators
            if (detectMenu(text) && !menuDisplayed) {
                menuDisplayed = true;
                console.log("🎯 Menu/choices detected in error stream - sending Enter key...");
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

        // Handle process errors
        claudeProcess.on("error", (error) => {
            console.error("Error spawning Claude process:", error);
            throw error;
        });

        // Wait a moment for Claude to initialize
        await new Promise((resolve) => setTimeout(resolve, 1000));

        // Send /login command to Claude Code
        console.log("Sending /login command...");
        claudeProcess.stdin.write("/login\n");

        // Wait for menu to appear (menu is always displayed)
        console.log("⏳ Waiting for login menu to appear...");

        // Wait for menu to be detected and Enter to be sent
        let menuProcessed = false;
        const menuWaitTime = 10000; // 10 seconds to wait for menu
        const menuStartTime = Date.now();

        while (!menuProcessed && (Date.now() - menuStartTime) < menuWaitTime) {
            await new Promise((resolve) => setTimeout(resolve, 500));
            if (menuDisplayed) {
                menuProcessed = true;
                console.log("✅ Menu detected and Enter key sent successfully");
                break;
            }
        }

        if (!menuProcessed) {
            console.warn("⚠️ Menu was not detected within timeout, but proceeding...");
        }

        // Wait additional time for URL to appear after menu selection
        console.log("⏳ Waiting for authentication URL to appear...");
        await new Promise((resolve) => setTimeout(resolve, 5000));

        // Keep connection open for additional responses
        console.log("🔄 Keeping connection open for authentication completion...");

        // Wait for the process to complete or timeout
        const timeoutMs = 120000; // 2 minutes timeout for login
        const exitCode = await new Promise<number>((resolve, reject) => {
            let resolved = false;

            // Set timeout
            const timeoutId = setTimeout(() => {
                if (!resolved) {
                    console.error("Claude login process timed out");
                    if (loginUrl) {
                        console.log("🔗 Login URL was:", loginUrl);
                        console.log("💡 You can manually visit this URL to complete authentication");
                    }
                    // Clear URL check interval
                    clearInterval(urlCheckInterval);
                    // Close stdin before killing process
                    try {
                        claudeProcess.stdin.end();
                    } catch (e) {
                        // Ignore errors when closing stdin
                    }
                    claudeProcess.kill("SIGTERM");
                    // Give it 3 seconds to terminate gracefully
                    setTimeout(() => {
                        try {
                            claudeProcess.kill("SIGKILL");
                        } catch (e) {
                            // Process may already be dead
                        }
                    }, 3000);
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
                urlDetected = true;
                console.log("🎯 FINAL INTERCEPTED URL:", finalUrl);
            }
        }

        if (exitCode === 0) {
            console.log("Login process completed successfully");
            if (loginUrl) {
                console.log("🔗 Final login URL:", loginUrl);
            }
            if (output) {
                console.log("Output:", output);
            }
            return { success: true, output, errorOutput, loginUrl };
        } else {
            console.error("Login process failed");
            if (loginUrl) {
                console.log("🔗 Login URL was:", loginUrl);
            }
            if (errorOutput) {
                console.error("Error output:", errorOutput);
            }
            return { success: false, output, errorOutput, loginUrl };
        }

    } catch (error) {
        console.error("Failed to refresh tokens:", error);
        const errorMessage = error instanceof Error ? error.message : String(error);
        return { success: false, error: errorMessage };
    } finally {
        // Clean up temporary files and directory
        if (mockScriptsCreated) {
            try {
                for (const script of mockScripts) {
                    const scriptPath = join(tempDir, script.name);
                    await unlink(scriptPath).catch(() => { }); // Ignore errors
                }
                await rmdir(tempDir).catch(() => { }); // Ignore errors
                console.log("🧹 Cleaned up mock scripts");
            } catch (e) {
                console.log("Warning: Failed to clean up mock scripts:", e);
            }
        }

        // Clean up intercepted URL file
        try {
            await unlink("/tmp/claude-intercepted-url.txt").catch(() => { });
        } catch (e) {
            // Ignore cleanup errors
        }
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
                if (result.output) {
                    console.log("\n📋 Output Summary:");
                    console.log(result.output);
                }
                process.exit(0);
            } else {
                console.error("❌ Token refresh failed");
                if (result.loginUrl) {
                    console.log("🔗 Login URL was:", result.loginUrl);
                }
                if (result.error) {
                    console.error("Error:", result.error);
                }
                if (result.errorOutput) {
                    console.error("Error output:", result.errorOutput);
                }
                process.exit(1);
            }
        })
        .catch((error) => {
            console.error("❌ Token refresh failed with exception:", error);
            process.exit(1);
        });
} 