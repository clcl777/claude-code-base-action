import { exec, spawn } from "child_process";
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

    try {
        // Launch Claude Code process in interactive mode
        const claudeProcess = spawn("claude", [], {
            stdio: ["pipe", "pipe", "pipe"],
        });

        let output = "";
        let errorOutput = "";
        let isLoginPrompted = false;
        let loginUrl = "";
        let menuDisplayed = false;
        let urlDetected = false;

        // Function to extract URL from text
        const extractUrl = (text: string): string | null => {
            // Look for URLs starting with http:// or https://
            const urlRegex = /https?:\/\/[^\s<>"{}|\\^`[\]]+/g;
            const matches = text.match(urlRegex);
            if (matches && matches.length > 0) {
                return matches[0];
            }
            return null;
        };

        // Function to detect if menu/choices are displayed
        const detectMenu = (text: string): boolean => {
            const menuIndicators = [
                "Choose an option",
                "Select an option",
                "Select login method",
                "Press Enter",
                "continue",
                "►",
                "→",
                ">",
                "1)",
                "2)",
                "[Enter]",
                "(Enter)",
                "to continue",
                "to proceed"
            ];
            return menuIndicators.some(indicator =>
                text.toLowerCase().includes(indicator.toLowerCase())
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
                console.log("🌐 Browser should open automatically to this URL");
            }

            // Check for specific login-related messages
            if (text.includes("Opening browser") || text.includes("Visit this URL")) {
                console.log("📋 Login process initiated - please complete authentication in your browser");
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
                    resolved = true;
                    resolve(code || 0);
                }
            });

            claudeProcess.on("error", (error) => {
                if (!resolved) {
                    clearTimeout(timeoutId);
                    resolved = true;
                    reject(error);
                }
            });
        });

        console.log(`Claude process exited with code: ${exitCode}`);

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