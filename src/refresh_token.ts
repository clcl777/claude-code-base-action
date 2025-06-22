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
            if (url) {
                loginUrl = url;
                console.log("🔗 Login URL detected:", url);
                console.log("🌐 Browser should open automatically to this URL");
            }

            // Check for specific login-related messages
            if (text.includes("Opening browser") || text.includes("Visit this URL")) {
                console.log("📋 Login process initiated - please complete authentication in your browser");
            }
        });

        // Capture stderr
        claudeProcess.stderr.on("data", (data) => {
            const text = data.toString();
            console.log("Claude Error:", text);
            errorOutput += text;

            // Also check stderr for URLs (some applications output URLs to stderr)
            const url = extractUrl(text);
            if (url && !loginUrl) {
                loginUrl = url;
                console.log("🔗 Login URL detected in error stream:", url);
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

        // Wait for response and potentially send additional commands
        await new Promise((resolve) => setTimeout(resolve, 3000)); // Increased wait time

        // If needed, we can send additional input here
        // For example, if Claude prompts for specific actions
        if (output.includes("Press Enter") || output.includes("continue")) {
            console.log("Sending Enter to continue...");
            claudeProcess.stdin.write("\n");
        }

        // Wait a bit more for URL to appear
        await new Promise((resolve) => setTimeout(resolve, 2000));

        // Close stdin to signal we're done sending input
        claudeProcess.stdin.end();

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