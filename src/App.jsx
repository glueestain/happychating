import React, { useEffect, useMemo, useRef, useState } from "react";
import * as sdk from "matrix-js-sdk";

function loadSession() {
    try {
        return JSON.parse(localStorage.getItem("happychat_session") || "null");
    } catch {
        return null;
    }
}
function saveSession(s) {
    localStorage.setItem("happychat_session", JSON.stringify(s));
}
function clearSession() {
    localStorage.removeItem("happychat_session");
}

function normalizeHomeserver(hs) {
    const v = (hs || "").trim();
    if (!v) return "";
    return v.startsWith("http://") || v.startsWith("https://") ? v : `https://${v}`;
}

function normalizeMxId(input, myUserId) {
    const v = (input || "").trim();
    if (!v) return "";
    // if user typed @name:server -> ok
    if (v.startsWith("@") && v.includes(":")) return v;
    // if user typed name (no @, no :) -> attach my server
    const myServer = (myUserId || "").split(":")[1] || "matrix.org";
    const name = v.startsWith("@") ? v.slice(1) : v;
    return `@${name}:${myServer}`;
}

export default function App() {
    const [session, setSession] = useState(loadSession());
    const [client, setClient] = useState(null);

    const [rooms, setRooms] = useState([]);
    const [activeRoomId, setActiveRoomId] = useState(null);

    const activeRoom = useMemo(
        () => (client && activeRoomId ? client.getRoom(activeRoomId) : null),
        [client, activeRoomId]
    );

    const [events, setEvents] = useState([]);
    const [message, setMessage] = useState("");

    // Mobile detection (and keep it updated)
    const [isMobile, setIsMobile] = useState(
        typeof window !== "undefined" ? window.innerWidth < 900 : false
    );
    const isMobileRef = useRef(isMobile);
    useEffect(() => {
        isMobileRef.current = isMobile;
    }, [isMobile]);

    useEffect(() => {
        function onResize() {
            const m = window.innerWidth < 900;
            setIsMobile(m);
            isMobileRef.current = m;
        }
        window.addEventListener("resize", onResize);
        return () => window.removeEventListener("resize", onResize);
    }, []);

    // Start client from saved session
    useEffect(() => {
        if (!session) return;

        const c = sdk.createClient({
            baseUrl: session.baseUrl,
            accessToken: session.accessToken,
            userId: session.userId,
            deviceId: session.deviceId,
        });

        setClient(c);

        const onSync = (state) => {
            if (state === "PREPARED") {
                const rs = c
                    .getRooms()
                    .slice()
                    .sort((a, b) => {
                        const ta = a.getLastActiveTimestamp?.() || 0;
                        const tb = b.getLastActiveTimestamp?.() || 0;
                        return tb - ta;
                    });

                setRooms(rs);

                // On desktop: auto-open first room (optional)
                // On mobile: do NOT auto-open (show list)
                if (!isMobileRef.current && !activeRoomId && rs[0]) {
                    setActiveRoomId(rs[0].roomId);
                }
            }
        };

        const onRoomTimeline = (ev, room, toStartOfTimeline) => {
            if (toStartOfTimeline) return;
            if (!room || room.roomId !== activeRoomId) return;
            const timeline = room.getLiveTimeline().getEvents();
            setEvents(timeline);
        };

        c.on("sync", onSync);
        c.on("Room.timeline", onRoomTimeline);

        c.startClient({ initialSyncLimit: 20 });

        return () => {
            c.removeListener("sync", onSync);
            c.removeListener("Room.timeline", onRoomTimeline);
            try {
                c.stopClient();
            } catch {}
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [session, activeRoomId]);

    // When room changes, refresh events list
    useEffect(() => {
        if (!activeRoom) return setEvents([]);
        const timeline = activeRoom.getLiveTimeline().getEvents();
        setEvents(timeline);
    }, [activeRoomId, activeRoom]);

    async function login({ homeserver, username, password }) {
        const baseUrl = normalizeHomeserver(homeserver);
        if (!baseUrl) throw new Error("Homeserver is empty");

        const temp = sdk.createClient({ baseUrl });
        const res = await temp.login("m.login.password", {
            user: username,
            password,
        });

        const s = {
            baseUrl,
            accessToken: res.access_token,
            userId: res.user_id,
            deviceId: res.device_id,
        };
        saveSession(s);
        setSession(s);
    }

    async function logout() {
        try {
            if (client) await client.logout();
        } catch {}
        clearSession();
        setClient(null);
        setSession(null);
        setRooms([]);
        setActiveRoomId(null);
        setEvents([]);
    }

    async function send() {
        if (!client || !activeRoomId) return;
        const text = message.trim();
        if (!text) return;

        const txnId = client.makeTxnId ? client.makeTxnId() : `${Date.now()}`;
        await client.sendEvent(
            activeRoomId,
            "m.room.message",
            { msgtype: "m.text", body: text },
            txnId
        );
        setMessage("");
    }

    async function startDM() {
        if (!client || !session?.userId) return;

        const raw = window.prompt("Введите Matrix ID собеседника (например @user:matrix.org)");
        if (!raw) return;

        const mxid = normalizeMxId(raw, session.userId);

        try {
            const room = await client.createRoom({
                invite: [mxid],
                is_direct: true,
                preset: "trusted_private_chat",
                name: `DM with ${mxid}`,
            });

            // createRoom returns { room_id: "..." }
            const roomId = room?.room_id || room?.roomId;
            if (roomId) setActiveRoomId(roomId);
        } catch (e) {
            alert(String(e?.message || e));
        }
    }

    if (!session) {
        return <Login onLogin={login} />;
    }

    // ---------- MOBILE UI ----------
    if (isMobile) {
        return (
            <div
                style={{
                    height: "100vh",
                    fontFamily: "system-ui",
                    display: "flex",
                    flexDirection: "column",
                }}
            >
                <header
                    style={{
                        padding: 12,
                        borderBottom: "1px solid #ddd",
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "center",
                        gap: 8,
                    }}
                >
                    <b>HappyChat</b>
                    <div style={{ display: "flex", gap: 8 }}>
                        <button onClick={startDM}>New chat</button>
                        <button onClick={logout}>Logout</button>
                    </div>
                </header>

                {!activeRoomId ? (
                    <RoomListMobile rooms={rooms} onOpen={(id) => setActiveRoomId(id)} />
                ) : (
                    <RoomMobile
                        room={activeRoom}
                        events={events}
                        message={message}
                        setMessage={setMessage}
                        onSend={send}
                        onBack={() => setActiveRoomId(null)}
                    />
                )}
            </div>
        );
    }

    // ---------- DESKTOP UI ----------
    return (
        <div style={{ display: "flex", height: "100vh", fontFamily: "system-ui" }}>
            <aside style={{ width: 320, borderRight: "1px solid #ddd", padding: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <b>HappyChat</b>
                    <div style={{ display: "flex", gap: 8 }}>
                        <button onClick={startDM}>New chat</button>
                        <button onClick={logout}>Logout</button>
                    </div>
                </div>

                <div style={{ marginTop: 12, overflow: "auto", height: "calc(100vh - 90px)" }}>
                    {rooms.map((r) => (
                        <div
                            key={r.roomId}
                            onClick={() => setActiveRoomId(r.roomId)}
                            style={{
                                padding: "10px 8px",
                                borderRadius: 10,
                                cursor: "pointer",
                                background: r.roomId === activeRoomId ? "#f2f2f2" : "transparent",
                                marginBottom: 6,
                            }}
                        >
                            <div style={{ fontWeight: 600 }}>{r.name || r.roomId}</div>
                            <div style={{ fontSize: 12, color: "#666" }}>
                                {r.getLastLiveEvent?.()?.getContent?.()?.body || ""}
                            </div>
                        </div>
                    ))}
                    {rooms.length === 0 ? (
                        <div style={{ color: "#666", marginTop: 12 }}>No rooms yet. Нажми “New chat”.</div>
                    ) : null}
                </div>
            </aside>

            <main style={{ flex: 1, display: "flex", flexDirection: "column" }}>
                <header style={{ padding: 12, borderBottom: "1px solid #ddd" }}>
                    <b>{activeRoom?.name || "Select a room"}</b>
                </header>

                <section style={{ flex: 1, overflow: "auto", padding: 12 }}>
                    {activeRoom ? (
                        events
                            .filter((e) => e.getType?.() === "m.room.message")
                            .slice(-200)
                            .map((e) => (
                                <div
                                    key={e.getId?.() || `${e.getSender?.() || "u"}-${e.getTs?.() || Math.random()}`}
                                    style={{ marginBottom: 10 }}
                                >
                                    <div style={{ fontSize: 12, color: "#666" }}>{e.getSender?.()}</div>
                                    <div>{e.getContent?.()?.body}</div>
                                </div>
                            ))
                    ) : (
                        <div style={{ color: "#666" }}>Выбери чат слева или нажми “New chat”.</div>
                    )}
                </section>

                <footer style={{ padding: 12, borderTop: "1px solid #ddd", display: "flex", gap: 8 }}>
                    <input
                        value={message}
                        onChange={(e) => setMessage(e.target.value)}
                        onKeyDown={(e) => (e.key === "Enter" ? send() : null)}
                        placeholder="Message"
                        style={{ flex: 1, padding: 10, borderRadius: 10, border: "1px solid #ccc" }}
                        disabled={!activeRoomId}
                    />
                    <button onClick={send} style={{ padding: "10px 14px" }} disabled={!activeRoomId}>
                        Send
                    </button>
                </footer>
            </main>
        </div>
    );
}

function Login({ onLogin }) {
    const [homeserver, setHomeserver] = useState("matrix.org");
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");
    const [err, setErr] = useState("");
    const [loading, setLoading] = useState(false);

    return (
        <div style={{ maxWidth: 420, margin: "40px auto", fontFamily: "system-ui", padding: 12 }}>
            <h2>Login</h2>
            <p style={{ color: "#666" }}>
                Homeserver: <code>matrix.org</code> (или твой). Username лучше вставлять полностью:{" "}
                <code>@name:server</code>
            </p>

            <label>Homeserver</label>
            <input
                value={homeserver}
                onChange={(e) => setHomeserver(e.target.value)}
                style={{ width: "100%", padding: 10, margin: "6px 0 12px" }}
                autoCapitalize="none"
                autoCorrect="off"
            />

            <label>Username</label>
            <input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                style={{ width: "100%", padding: 10, margin: "6px 0 12px" }}
                autoCapitalize="none"
                autoCorrect="off"
            />

            <label>Password</label>
            <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                style={{ width: "100%", padding: 10, margin: "6px 0 12px" }}
            />

            {err ? <div style={{ color: "crimson", marginBottom: 10 }}>{err}</div> : null}

            <button
                disabled={loading}
                onClick={async () => {
                    setErr("");
                    setLoading(true);
                    try {
                        await onLogin({ homeserver, username, password });
                    } catch (e) {
                        setErr(String(e?.message || e));
                        setLoading(false);
                    }
                }}
                style={{ padding: "10px 14px" }}
            >
                {loading ? "Loading..." : "Login"}
            </button>
        </div>
    );
}

function RoomListMobile({ rooms, onOpen }) {
    return (
        <div style={{ padding: 12, overflow: "auto" }}>
            {rooms.map((r) => (
                <div
                    key={r.roomId}
                    onClick={() => onOpen(r.roomId)}
                    style={{
                        padding: 12,
                        borderRadius: 12,
                        border: "1px solid #eee",
                        marginBottom: 10,
                    }}
                >
                    <div style={{ fontWeight: 700 }}>{r.name || r.roomId}</div>
                    <div style={{ fontSize: 12, color: "#666" }}>
                        {r.getLastLiveEvent?.()?.getContent?.()?.body || ""}
                    </div>
                </div>
            ))}
            {rooms.length === 0 ? <div style={{ color: "#666" }}>No rooms yet. Нажми “New chat”.</div> : null}
        </div>
    );
}

function RoomMobile({ room, events, message, setMessage, onSend, onBack }) {
    return (
        <div style={{ flex: 1, display: "flex", flexDirection: "column" }}>
            <header
                style={{
                    padding: 12,
                    borderBottom: "1px solid #ddd",
                    display: "flex",
                    gap: 8,
                    alignItems: "center",
                }}
            >
                <button onClick={onBack}>←</button>
                <b style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {room?.name || "Chat"}
                </b>
            </header>

            <div style={{ flex: 1, overflow: "auto", padding: 12 }}>
                {events
                    .filter((e) => e.getType?.() === "m.room.message")
                    .slice(-200)
                    .map((e) => (
                        <div
                            key={e.getId?.() || `${e.getSender?.() || "u"}-${e.getTs?.() || Math.random()}`}
                            style={{ marginBottom: 12 }}
                        >
                            <div style={{ fontSize: 12, color: "#666" }}>{e.getSender?.()}</div>
                            <div>{e.getContent?.()?.body}</div>
                        </div>
                    ))}
            </div>

            <div style={{ padding: 12, borderTop: "1px solid #ddd", display: "flex", gap: 8 }}>
                <input
                    value={message}
                    onChange={(e) => setMessage(e.target.value)}
                    onKeyDown={(e) => (e.key === "Enter" ? onSend() : null)}
                    placeholder="Message"
                    style={{ flex: 1, padding: 10, borderRadius: 10, border: "1px solid #ccc" }}
                />
                <button onClick={onSend} style={{ padding: "10px 14px" }}>
                    Send
                </button>
            </div>
        </div>
    );
}
