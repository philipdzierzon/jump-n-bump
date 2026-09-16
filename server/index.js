import express from "express";
import { WebSocketServer } from "ws";

const port = process.env.PORT || 8080;
const app = express();

app.use(express.static(process.env.CLIENT_DIR || "../game"));
app.get("/healthz", (_req, res) => res.type("text/plain").send("ok"));

const server = app.listen(port, "0.0.0.0", () => console.log(`listening on :${port}`));

// ponytail: hello-world relay — echoes what it is sent. The real room/relay
// logic lands with the build tickets; this exists to prove the TLS path.
new WebSocketServer({ server }).on("connection", (ws) => {
    ws.send(JSON.stringify({ type: "hello" }));
    ws.on("message", (data) => ws.send(data.toString()));
});
