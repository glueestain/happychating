// src/App.jsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import * as sdk from "matrix-js-sdk";

// -------------------- storage --------------------
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

// -------------------- helpers --------------------
function normalizeHomeserver(hs) {
    const v = (hs || "").trim();
    if (!v) return "";
    return v.startsWith("http://") || v.startsWith("https://") ? v : `https://${v}`;
}

function normalizeMxId(input, myUserId) {
    const v = (input || "").trim();
    if (!v) return "";
    if (v.startsWith("@") && v.includes(":")) return v;

    const myServer = (myUserId || "").split(":")[1] || "matrix.org";
    const name = v.startsWith("@") ? v.slice(1) : v;
    return `@${name}:${myServer}`;
}

function formatTime(ts) {
    if (!ts) return "";
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${hh}:${mm}`;
}

function safeText(v) {
    if (typeof v !== "string") return "";
    return v;
}

function truncateMiddle(s, max = 22) {
    if (!s || s.length <= max) return s;
    const left = Math.ceil((max - 3) / 2);
    const right = Math.floor((max - 3) / 2);
    return `${s.slice(0, left)}...${s.slice(s.length - right)}`;
}

// -------------------- App --------------------
export default function App() {
    const [session, setSession] = useState(loadSession());
    const [client, setClient] = useState(null);

    const [rooms, setRooms] = useState([]);
    const [activeRoomId, setActiveRoomId] = useState(null);
    const [events, setEvents] = useState([]);

    const [message, setMessage] = useState("");

    // UI
    const [query, setQuery] = useState("");
    const [isMobile, setIsMobile] = useState(
        typeof window !== "undefined" ? window.innerWidth < 900 : false
    );

    const [newChatOpen, setNewChatOpen] = useState(false);
    const [newChatInput, setNewChatInput] = useState("");
    const [newChatBusy, setNewChatBusy] = useState(false);

    const [typingUsers, setTypingUsers] = useState([]);

    const myUserId = session?.userId || null;

    const activeRoom = useMemo(
        () => (client && activeRoomId ? client.getRoom(activeRoomId) : null),
        [client, activeRoomId]
    );

    // Resize -> mobile
    useEffect(() => {
        function onResize() {
            setIsMobile(window.innerWidth < 900);
        }
        window.addEventListener("resize", onResize);
        return () => window.removeEventListener("resize", onResize);
    }, []);

    // displayname helper
    function senderDisplayName(room, senderId) {
        if (!room || !senderId) return senderId || "";
        try {
            const m = room.getMember?.(senderId);
            const n = m?.name || m?.rawDisplayName || m?.displayName;
            return n || senderId;
        } catch {
            return senderId;
        }
    }

    // room avatar helper
    function roomAvatarUrl(room, size = 64) {
        if (!client || !room) return null;
        try {
            const url = room.getAvatarUrl?.(
                client.getHomeserverUrl(),
                size,
                size,
                "scale",
                true
            );
            return url || null;
        } catch {
            return null;
        }
    }

    // Start client from session + init E2E
    useEffect(() => {
        if (!session) return;

        const c = sdk.createClient({
            baseUrl: session.baseUrl,
            accessToken: session.accessToken,
            userId: session.userId,
            deviceId: session.deviceId,
        });

        setClient(c);

        const updateRooms = () => {
            const rs = c
                .getRooms()
                .slice()
                .sort((a, b) => {
                    const ta = a.getLastActiveTimestamp?.() || 0;
                    const tb = b.getLastActiveTimestamp?.() || 0;
                    return tb - ta;
                });
            setRooms(rs);

            // desktop auto-open first room
            if (!isMobile && !activeRoomId && rs[0]) setActiveRoomId(rs[0].roomId);
        };

        const updateTypingForActive = () => {
            if (!activeRoomId) {
                setTypingUsers([]);
                return;
            }
            const room = c.getRoom(activeRoomId);
            if (!room) {
                setTypingUsers([]);
                return;
            }
            const typing = room.getTypingMembers?.() || [];
            const names = typing
                .map((m) => m?.name || m?.rawDisplayName || m?.displayName || m?.userId)
                .filter((n) => n)
                .filter((n) => n !== myUserId) // грубо, но нормально для UI
                .slice(0, 3);
            setTypingUsers(names);
        };

        const onSync = (state) => {
            if (state === "PREPARED") {
                updateRooms();
                updateTypingForActive();
            }
        };

        const onRoomTimeline = (ev, room, toStartOfTimeline) => {
            if (toStartOfTimeline) return;
            if (!room || room.roomId !== activeRoomId) return;

            // добавляем только новое событие
            setEvents((prev) => {
                const next = prev.concat(ev);
                return next.length > 200 ? next.slice(next.length - 200) : next;
            });

            // updateRooms НЕ дергаем на каждое сообщение (см. C)
        };
        let roomsUpdateTimer = null;
        const scheduleRoomsUpdate = () => {
            if (roomsUpdateTimer) return;
            roomsUpdateTimer = setTimeout(() => {
                roomsUpdateTimer = null;
                updateRooms();
            }, 500);
        };
        const onRoom = () => updateRooms();

        const onTyping = (room) => {
            if (!room || room.roomId !== activeRoomId) return;
            updateTypingForActive();
        };

        c.on("sync", onSync);
        c.on("Room.timeline", onRoomTimeline);
        c.on("Room", onRoom);
        c.on("RoomMember.typing", onTyping);

        // ВАЖНО: включаем E2E (best-effort) и только потом стартуем клиент
        (async () => {
            try {
                if (typeof c.initRustCrypto === "function") {
                    await c.initRustCrypto({
                        useIndexedDB: true,
                        cryptoDatabasePrefix: `happychat_${(session.userId || "u").replace(/[^a-z0-9]/gi, "_")}`,
                    });
                }
            } catch (e) {
                console.warn("E2E init failed:", e);
            }

            c.startClient({
                initialSyncLimit: 10,
                lazyLoadMembers: true,
            });

        })();

        return () => {
            c.removeListener("sync", onSync);
            c.removeListener("Room.timeline", onRoomTimeline);
            c.removeListener("Room", onRoom);
            c.removeListener("RoomMember.typing", onTyping);
            try {
                c.stopClient();
            } catch {}
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [session, activeRoomId, isMobile, myUserId]);

    // When room changes -> refresh events + typing list
    useEffect(() => {
        if (!activeRoom || !client) {
            setEvents([]);
            setTypingUsers([]);
            return;
        }
        const timeline = activeRoom.getLiveTimeline().getEvents();
        setEvents(timeline);

        try {
            const typing = activeRoom.getTypingMembers?.() || [];
            const names = typing
                .map((m) => m?.name || m?.rawDisplayName || m?.displayName || m?.userId)
                .filter(Boolean)
                .filter((n) => n !== myUserId)
                .slice(0, 3);
            setTypingUsers(names);
        } catch {
            setTypingUsers([]);
        }
    }, [activeRoomId, activeRoom, client, myUserId]);

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
        setMessage("");
        setTypingUsers([]);
    }

    async function send() {
        if (!client || !activeRoomId) return;
        const text = message.trim();
        if (!text) return;

        // stop typing
        try {
            await client.sendTyping(activeRoomId, false);
        } catch {}

        const txnId = client.makeTxnId ? client.makeTxnId() : `${Date.now()}`;
        await client.sendEvent(
            activeRoomId,
            "m.room.message",
            { msgtype: "m.text", body: text },
            txnId
        );
        setMessage("");
    }

    // DM with E2E (m.room.encryption) — ONLY for DM
    async function startDM() {
        if (!client || !myUserId) return;
        const mxid = normalizeMxId(newChatInput, myUserId);
        if (!mxid) return;

        setNewChatBusy(true);
        try {
            const roomRes = await client.createRoom({
                invite: [mxid],
                is_direct: true,
                preset: "trusted_private_chat",
                name: `DM with ${mxid}`,

                // E2E for DM
                initial_state: [
                    {
                        type: "m.room.encryption",
                        state_key: "",
                        content: { algorithm: "m.megolm.v1.aes-sha2" },
                    },
                ],
            });

            const roomId = roomRes?.room_id || roomRes?.roomId;
            setNewChatOpen(false);
            setNewChatInput("");
            if (roomId) setActiveRoomId(roomId);
        } catch (e) {
            alert(String(e?.message || e));
        } finally {
            setNewChatBusy(false);
        }
    }

    const filteredRooms = useMemo(() => {
        const q = query.trim().toLowerCase();
        if (!q) return rooms;
        return rooms.filter((r) => {
            const name = (r.name || r.roomId || "").toLowerCase();
            const last = (r.getLastLiveEvent?.()?.getContent?.()?.body || "").toLowerCase();
            return name.includes(q) || last.includes(q);
        });
    }, [rooms, query]);

    // typing debounce/throttle
    const typingTimerRef = useRef(null);
    const typingActiveRef = useRef(false);

    async function sendTyping(isTyping) {
        if (!client || !activeRoomId) return;
        try {
            if (isTyping) {
                if (!typingActiveRef.current) {
                    typingActiveRef.current = true;
                    await client.sendTyping(activeRoomId, true, 4000);
                } else {
                    await client.sendTyping(activeRoomId, true, 4000);
                }
            } else {
                typingActiveRef.current = false;
                await client.sendTyping(activeRoomId, false);
            }
        } catch {}
    }

    function onComposerChange(next) {
        setMessage(next);

        if (!next.trim()) {
            if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
            typingTimerRef.current = setTimeout(() => {
                sendTyping(false);
            }, 200);
            return;
        }

        sendTyping(true);

        if (typingTimerRef.current) clearTimeout(typingTimerRef.current);
        typingTimerRef.current = setTimeout(() => {
            sendTyping(false);
        }, 2200);
    }

    // -------------- render --------------
    if (!session) {
        return <Login onLogin={login} />;
    }

    const shellStyle = {
        height: "100vh",
        fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Arial",
        background: "#fff",
        color: "#111",
    };

    // Mobile
    if (isMobile) {
        return (
            <div style={shellStyle}>
                <TopBar
                    title="HappyChat"
                    right={
                        <>
                            <Btn onClick={() => setNewChatOpen(true)}>New</Btn>
                            <Btn onClick={logout} subtle>
                                Logout
                            </Btn>
                        </>
                    }
                />

                {!activeRoomId ? (
                    <div style={{ padding: 12 }}>
                        <SearchBox value={query} onChange={setQuery} />
                        <div style={{ height: 10 }} />
                        <RoomList
                            rooms={filteredRooms}
                            activeRoomId={null}
                            onOpen={(id) => setActiveRoomId(id)}
                            roomAvatarUrl={roomAvatarUrl}
                            senderDisplayName={senderDisplayName}
                            emptyHint="Пока нет чатов. Нажми New."
                            myUserId={myUserId}
                        />
                    </div>
                ) : (
                    <ChatView
                        myUserId={myUserId}
                        room={activeRoom}
                        events={events}
                        typingUsers={typingUsers}
                        message={message}
                        setMessage={onComposerChange}
                        onSend={send}
                        onBack={() => setActiveRoomId(null)}
                        client={client}
                        senderDisplayName={senderDisplayName}
                    />
                )}

                {newChatOpen ? (
                    <Modal
                        title="New chat (E2E DM)"
                        onClose={() => {
                            if (!newChatBusy) setNewChatOpen(false);
                        }}
                    >
                        <div style={{ color: "#666", fontSize: 13, marginBottom: 10 }}>
                            Введи Matrix ID (например <code>@user:matrix.org</code>) или просто ник (подставится твой сервер).
                            <br />
                            Этот DM будет создан <b>с E2E</b>.
                        </div>

                        <input
                            value={newChatInput}
                            onChange={(e) => setNewChatInput(e.target.value)}
                            placeholder="@user:matrix.org"
                            autoCapitalize="none"
                            autoCorrect="off"
                            style={inputStyle}
                        />

                        <div style={{ height: 12 }} />
                        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                            <Btn
                                subtle
                                onClick={() => {
                                    if (!newChatBusy) setNewChatOpen(false);
                                }}
                            >
                                Cancel
                            </Btn>
                            <Btn onClick={startDM} disabled={newChatBusy || !newChatInput.trim()}>
                                {newChatBusy ? "Creating..." : "Create"}
                            </Btn>
                        </div>
                    </Modal>
                ) : null}
            </div>
        );
    }

    // Desktop
    return (
        <div style={{ ...shellStyle, display: "flex" }}>
            <aside style={sidebarStyle}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                    <div style={{ fontWeight: 800, letterSpacing: 0.2 }}>HappyChat</div>
                    <div style={{ display: "flex", gap: 8 }}>
                        <Btn onClick={() => setNewChatOpen(true)}>New</Btn>
                        <Btn onClick={logout} subtle>
                            Logout
                        </Btn>
                    </div>
                </div>

                <div style={{ height: 12 }} />
                <SearchBox value={query} onChange={setQuery} />

                <div style={{ height: 12 }} />
                <div style={{ overflow: "auto", height: "calc(100vh - 120px)" }}>
                    <RoomList
                        rooms={filteredRooms}
                        activeRoomId={activeRoomId}
                        onOpen={(id) => setActiveRoomId(id)}
                        roomAvatarUrl={roomAvatarUrl}
                        senderDisplayName={senderDisplayName}
                        emptyHint="Пока нет чатов. Нажми New."
                        myUserId={myUserId}
                    />
                </div>
            </aside>

            <main style={{ flex: 1, minWidth: 0 }}>
                {activeRoom ? (
                    <ChatView
                        myUserId={myUserId}
                        room={activeRoom}
                        events={events}
                        typingUsers={typingUsers}
                        message={message}
                        setMessage={onComposerChange}
                        onSend={send}
                        client={client}
                        senderDisplayName={senderDisplayName}
                    />
                ) : (
                    <div style={{ height: "100vh", display: "grid", placeItems: "center", color: "#666" }}>
                        Выбери чат слева или нажми New.
                    </div>
                )}
            </main>

            {newChatOpen ? (
                <Modal
                    title="New chat (E2E DM)"
                    onClose={() => {
                        if (!newChatBusy) setNewChatOpen(false);
                    }}
                >
                    <div style={{ color: "#666", fontSize: 13, marginBottom: 10 }}>
                        Введи Matrix ID (например <code>@user:matrix.org</code>) или просто ник (подставится твой сервер).
                        <br />
                        Этот DM будет создан <b>с E2E</b>.
                    </div>

                    <input
                        value={newChatInput}
                        onChange={(e) => setNewChatInput(e.target.value)}
                        placeholder="@user:matrix.org"
                        autoCapitalize="none"
                        autoCorrect="off"
                        style={inputStyle}
                    />

                    <div style={{ height: 12 }} />
                    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                        <Btn
                            subtle
                            onClick={() => {
                                if (!newChatBusy) setNewChatOpen(false);
                            }}
                        >
                            Cancel
                        </Btn>
                        <Btn onClick={startDM} disabled={newChatBusy || !newChatInput.trim()}>
                            {newChatBusy ? "Creating..." : "Create"}
                        </Btn>
                    </div>
                </Modal>
            ) : null}
        </div>
    );
}

// -------------------- UI components --------------------
const sidebarStyle = {
    width: 360,
    borderRight: "1px solid #eee",
    padding: 14,
    boxSizing: "border-box",
};

const inputStyle = {
    width: "100%",
    padding: "12px 12px",
    borderRadius: 12,
    border: "1px solid #ddd",
    outline: "none",
    fontSize: 14,
    boxSizing: "border-box",
};

function TopBar({ title, right }) {
    return (
        <header
            style={{
                height: 52,
                padding: "0 12px",
                borderBottom: "1px solid #eee",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 10,
            }}
        >
            <div style={{ fontWeight: 800 }}>{title}</div>
            <div style={{ display: "flex", gap: 8 }}>{right}</div>
        </header>
    );
}

function Btn({ children, onClick, subtle, disabled }) {
    return (
        <button
            onClick={onClick}
            disabled={disabled}
            style={{
                padding: "8px 12px",
                borderRadius: 12,
                border: "1px solid " + (subtle ? "#e6e6e6" : "#111"),
                background: subtle ? "#fff" : "#111",
                color: subtle ? "#111" : "#fff",
                fontWeight: 700,
                cursor: disabled ? "not-allowed" : "pointer",
                opacity: disabled ? 0.6 : 1,
            }}
        >
            {children}
        </button>
    );
}

function SearchBox({ value, onChange }) {
    return (
        <input
            value={value}
            onChange={(e) => onChange(e.target.value)}
            placeholder="Search chats..."
            style={{
                width: "100%",
                padding: "10px 12px",
                borderRadius: 12,
                border: "1px solid #ddd",
                outline: "none",
                fontSize: 14,
                boxSizing: "border-box",
            }}
        />
    );
}

function RoomList({ rooms, activeRoomId, onOpen, roomAvatarUrl, senderDisplayName, emptyHint, myUserId }) {
    if (!rooms.length) {
        return <div style={{ color: "#666", padding: 12 }}>{emptyHint}</div>;
    }
    return (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {rooms.map((r) => {
                const avatar = roomAvatarUrl?.(r, 64);
                const lastEv = r.getLastLiveEvent?.();
                const lastBody = lastEv?.getContent?.()?.body || "";
                const lastSender = lastEv?.getSender?.() || "";
                const lastSenderName = lastSender ? senderDisplayName(r, lastSender) : "";
                const isActive = activeRoomId && r.roomId === activeRoomId;

                return (
                    <div
                        key={r.roomId}
                        onClick={() => onOpen(r.roomId)}
                        style={{
                            display: "flex",
                            gap: 10,
                            padding: 10,
                            borderRadius: 14,
                            border: "1px solid " + (isActive ? "#111" : "#eee"),
                            background: isActive ? "#111" : "#fff",
                            cursor: "pointer",
                        }}
                    >
                        <div
                            style={{
                                width: 44,
                                height: 44,
                                borderRadius: 14,
                                overflow: "hidden",
                                background: isActive ? "#222" : "#f3f3f3",
                                display: "grid",
                                placeItems: "center",
                                flex: "0 0 auto",
                            }}
                        >
                            {avatar ? (
                                <img src={avatar} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
                            ) : (
                                <div style={{ fontWeight: 900, color: isActive ? "#fff" : "#111" }}>
                                    {(r.name || "C").slice(0, 1).toUpperCase()}
                                </div>
                            )}
                        </div>

                        <div style={{ minWidth: 0, flex: 1 }}>
                            <div
                                style={{
                                    fontWeight: 800,
                                    color: isActive ? "#fff" : "#111",
                                    whiteSpace: "nowrap",
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                }}
                            >
                                {r.name || r.roomId}
                            </div>
                            <div
                                style={{
                                    fontSize: 13,
                                    color: isActive ? "#cfcfcf" : "#666",
                                    whiteSpace: "nowrap",
                                    overflow: "hidden",
                                    textOverflow: "ellipsis",
                                    marginTop: 2,
                                }}
                            >
                                {safeText(lastBody)
                                    ? `${lastSender ? (lastSender === myUserId ? "You" : truncateMiddle(lastSenderName, 18)) + ": " : ""}${safeText(lastBody)}`
                                    : ""}
                            </div>
                        </div>
                    </div>
                );
            })}
        </div>
    );
}

function ChatView({ myUserId, room, events, typingUsers, message, setMessage, onSend, onBack, client, senderDisplayName }) {
    const bottomRef = useRef(null);

    const msgEvents = useMemo(() => {
        return (events || [])
            .filter((e) => e.getType?.() === "m.room.message")
            .filter((e) => e.getContent?.()?.msgtype === "m.text" || e.getContent?.()?.body);
    }, [events]);

    // Auto-scroll
    useEffect(() => {
        bottomRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
    }, [msgEvents.length, room?.roomId]);

    // Send read receipt (best-effort)
    useEffect(() => {
        if (!client || !room || !msgEvents.length) return;
        const latest = [...msgEvents].reverse().find((e) => {
            const sender = e.getSender?.();
            return sender && sender !== myUserId;
        });
        if (!latest) return;

        try {
            if (typeof client.sendReadReceipt === "function") {
                client.sendReadReceipt(latest);
            } else if (typeof client.sendReceipt === "function") {
                client.sendReceipt(latest, "m.read");
            }
        } catch {}
    }, [client, room?.roomId, msgEvents.length, myUserId]);

    const typingLine = (typingUsers || []).filter(Boolean).join(", ");

    return (
        <div style={{ height: "100vh", display: "flex", flexDirection: "column", minWidth: 0 }}>
            <header
                style={{
                    height: 64,
                    padding: "0 12px",
                    borderBottom: "1px solid #eee",
                    display: "flex",
                    alignItems: "center",
                    gap: 10,
                }}
            >
                {onBack ? (
                    <button
                        onClick={onBack}
                        style={{
                            width: 40,
                            height: 40,
                            borderRadius: 12,
                            border: "1px solid #eee",
                            background: "#fff",
                            cursor: "pointer",
                            fontSize: 18,
                        }}
                    >
                        ←
                    </button>
                ) : null}

                <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontWeight: 900, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {room?.name || "Chat"}
                    </div>
                    <div style={{ fontSize: 12, color: "#666", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
                        {typingLine ? `${typingLine} typing…` : room?.roomId}
                    </div>
                </div>
            </header>

            <div style={{ flex: 1, overflow: "auto", padding: 12, background: "#fafafa" }}>
                {msgEvents.slice(-400).map((e) => {
                    const sender = e.getSender?.() || "";
                    const isMine = !!myUserId && sender === myUserId;
                    const senderName = sender ? senderDisplayName(room, sender) : "";
                    const body = safeText(e.getContent?.()?.body);
                    const ts = e.getTs?.();

                    return (
                        <div
                            key={e.getId?.() || `${sender}-${ts}-${Math.random()}`}
                            style={{
                                display: "flex",
                                justifyContent: isMine ? "flex-end" : "flex-start",
                                marginBottom: 10,
                            }}
                        >
                            <div
                                style={{
                                    maxWidth: "78%",
                                    padding: "10px 12px",
                                    borderRadius: 16,
                                    background: isMine ? "#111" : "#fff",
                                    border: isMine ? "1px solid #111" : "1px solid #e8e8e8",
                                    color: isMine ? "#fff" : "#111",
                                }}
                            >
                                {!isMine ? (
                                    <div style={{ fontSize: 12, color: "#666", marginBottom: 4 }}>
                                        {senderName || sender}
                                    </div>
                                ) : null}

                                <div style={{ whiteSpace: "pre-wrap", wordBreak: "break-word" }}>{body}</div>

                                <div
                                    style={{
                                        fontSize: 11,
                                        marginTop: 6,
                                        color: isMine ? "#cfcfcf" : "#888",
                                        textAlign: "right",
                                    }}
                                >
                                    {formatTime(ts)}
                                </div>
                            </div>
                        </div>
                    );
                })}
                <div ref={bottomRef} />
            </div>

            <footer style={{ padding: 12, borderTop: "1px solid #eee", background: "#fff" }}>
                <div style={{ display: "flex", gap: 8 }}>
                    <input
                        value={message}
                        onChange={(e) => setMessage(e.target.value)}
                        onKeyDown={(e) => (e.key === "Enter" ? onSend() : null)}
                        placeholder="Message"
                        style={{
                            flex: 1,
                            padding: "12px 12px",
                            borderRadius: 14,
                            border: "1px solid #ddd",
                            outline: "none",
                            fontSize: 14,
                        }}
                    />
                    <Btn onClick={onSend} disabled={!message.trim()}>
                        Send
                    </Btn>
                </div>
            </footer>
        </div>
    );
}

function Modal({ title, children, onClose }) {
    return (
        <div
            onMouseDown={onClose}
            style={{
                position: "fixed",
                inset: 0,
                background: "rgba(0,0,0,0.35)",
                display: "grid",
                placeItems: "center",
                padding: 12,
                zIndex: 1000,
            }}
        >
            <div
                onMouseDown={(e) => e.stopPropagation()}
                style={{
                    width: "min(520px, 100%)",
                    background: "#fff",
                    borderRadius: 18,
                    border: "1px solid #eee",
                    padding: 14,
                    boxShadow: "0 10px 30px rgba(0,0,0,0.18)",
                }}
            >
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10 }}>
                    <div style={{ fontWeight: 900 }}>{title}</div>
                    <button
                        onClick={onClose}
                        style={{
                            width: 40,
                            height: 40,
                            borderRadius: 12,
                            border: "1px solid #eee",
                            background: "#fff",
                            cursor: "pointer",
                            fontSize: 18,
                        }}
                    >
                        ×
                    </button>
                </div>
                <div style={{ height: 12 }} />
                {children}
            </div>
        </div>
    );
}

// -------------------- Login --------------------
function Login({ onLogin }) {
    const [homeserver, setHomeserver] = useState("matrix.org");
    const [username, setUsername] = useState("");
    const [password, setPassword] = useState("");

    const [err, setErr] = useState("");
    const [loading, setLoading] = useState(false);

    return (
        <div style={{ maxWidth: 440, margin: "40px auto", padding: 12, fontFamily: "system-ui" }}>
            <h2 style={{ marginBottom: 6 }}>Login</h2>
            <div style={{ color: "#666", fontSize: 13, marginBottom: 16 }}>
                Homeserver: <code>matrix.org</code> (или твой). Username лучше вставлять полностью:{" "}
                <code>@name:server</code>.
            </div>

            <div style={{ display: "grid", gap: 10 }}>
                <div>
                    <div style={{ fontWeight: 700, marginBottom: 6 }}>Homeserver</div>
                    <input
                        value={homeserver}
                        onChange={(e) => setHomeserver(e.target.value)}
                        style={inputStyle}
                        autoCapitalize="none"
                        autoCorrect="off"
                    />
                </div>

                <div>
                    <div style={{ fontWeight: 700, marginBottom: 6 }}>Username</div>
                    <input
                        value={username}
                        onChange={(e) => setUsername(e.target.value)}
                        style={inputStyle}
                        autoCapitalize="none"
                        autoCorrect="off"
                    />
                </div>

                <div>
                    <div style={{ fontWeight: 700, marginBottom: 6 }}>Password</div>
                    <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} style={inputStyle} />
                </div>

                {err ? <div style={{ color: "crimson" }}>{err}</div> : null}

                <Btn
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
                    disabled={loading || !homeserver.trim() || !username.trim() || !password}
                >
                    {loading ? "Loading..." : "Login"}
                </Btn>
            </div>
        </div>
    );
}
