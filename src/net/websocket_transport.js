// The client's half of the socket (#34). Same two methods as the loopback stub, so the
// room above it cannot tell which one it got (#16): everything room-shaped is in Room,
// and everything wire-shaped is here.
//
// The handshake and the latency probe never reach the room. `create` and `join` answer
// before a match exists, and a ping is measurement, not a message that moves anything.
export function WebSocket_Transport(url, entry, on_joined, on_error) {
    "use strict";
    var self = this;
    var socket = new WebSocket(url);
    var listener = null;
    var joined = false;

    socket.onopen = function () {
        // `create` with no id asks the relay to generate one; with an id it is the host's
        // own choice, and is refused honestly if that id is taken (#8).
        socket.send(JSON.stringify(entry));
    };

    socket.onmessage = function (event) {
        var msg = JSON.parse(event.data);
        switch (msg.type) {
            case "ping":
                // Echoed with the relay's own timestamp: one-way trip is its arithmetic
                // to do, and this client never needs to know the number (#34).
                socket.send(JSON.stringify({ type: "pong", at: msg.at }));
                break;
            case "joined":
                joined = true;
                if (on_joined) on_joined(msg);
                break;
            case "error":
                if (on_error) on_error(msg.code);
                // A refused handshake is the end of this socket: nothing else will ever
                // come down it, and the relay would go on pinging it once a second.
                if (!joined) self.close();
                break;
            default:
                if (listener) listener(msg);
        }
    };

    socket.onclose = function () {
        // ponytail: a closed socket is reported once and the match is over. upgrade path:
        // reserved seats, AI takeover and reconnect (#42).
        if (on_error) on_error("DISCONNECTED");
    };

    this.receive = function (fn) {
        listener = fn;
    };

    // Nothing is sent before the room answers: the session that does the sending is not
    // built until `joined` arrives.
    this.send = function (msg) {
        socket.send(JSON.stringify(msg));
    };

    this.close = function () {
        socket.onclose = null;
        socket.close();
    };
}
