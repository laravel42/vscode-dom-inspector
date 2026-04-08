import express from "express";
import cors from "cors";
import { execSync } from "child_process";
import { SelectedDomNodeSchema, StyleChangeSchema } from "./types.js";
import { setCurrentSelection, getCurrentSelection, clearCurrentSelection, addStyleChange, } from "./state.js";
const REQUEST_SIZE_LIMIT = "100kb";
/**
 * Kill whatever process is listening on the given port, then start our server.
 */
function killPortAndListen(app, port) {
    // Try to kill any existing process on this port
    try {
        const out = execSync(`lsof -ti tcp:${port}`, { encoding: "utf-8" }).trim();
        if (out) {
            for (const pid of out.split("\n")) {
                try {
                    process.kill(parseInt(pid, 10), "SIGTERM");
                    console.error(`[http] Killed stale process ${pid} on port ${port}`);
                }
                catch {
                    // Process already gone
                }
            }
            // Brief wait for port to free up
            execSync("sleep 0.3");
        }
    }
    catch {
        // No process on port — good
    }
    const server = app.listen(port, "127.0.0.1");
    server.on("listening", () => {
        console.error(`[http] DOM Inspector bridge listening on http://127.0.0.1:${port}`);
    });
    server.on("error", (err) => {
        console.error(`[http] Could not bind port ${port}: ${err.message}`);
    });
}
export function createHttpServer(port) {
    const app = express();
    app.use(cors({ origin: true }));
    app.use(express.json({ limit: REQUEST_SIZE_LIMIT }));
    // POST /selection — store a new selected DOM node
    app.post("/selection", (req, res) => {
        const result = SelectedDomNodeSchema.safeParse(req.body);
        if (!result.success) {
            res.status(400).json({
                ok: false,
                error: "Invalid payload",
                details: result.error.flatten().fieldErrors,
            });
            return;
        }
        const stored = setCurrentSelection(result.data);
        res.json({
            ok: true,
            selectedAt: stored.selectedAt,
            tagName: stored.node.tagName,
            selector: stored.node.selector,
        });
    });
    // GET /selection — return the current selection (debug)
    app.get("/selection", (_req, res) => {
        const sel = getCurrentSelection();
        if (!sel) {
            res.json({ ok: true, selection: null });
            return;
        }
        res.json({ ok: true, selection: sel });
    });
    // DELETE /selection — clear the current selection
    app.delete("/selection", (_req, res) => {
        clearCurrentSelection();
        res.json({ ok: true, cleared: true });
    });
    // POST /style-change — record a style change on the current selection
    app.post("/style-change", (req, res) => {
        const result = StyleChangeSchema.safeParse(req.body);
        if (!result.success) {
            res.status(400).json({ ok: false, error: "Invalid payload", details: result.error.flatten().fieldErrors });
            return;
        }
        addStyleChange(result.data);
        res.json({ ok: true });
    });
    // Global error handler
    app.use((err, _req, res, _next) => {
        console.error("[http] Unhandled error:", err.message);
        res.status(500).json({ ok: false, error: "Internal server error" });
    });
    killPortAndListen(app, port);
    return app;
}
//# sourceMappingURL=http.js.map