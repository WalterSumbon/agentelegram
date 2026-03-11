import { useEffect, useState, useRef } from 'react';
import {
  useStore,
  setConversations,
  addConversation,
  setActiveConversation,
  setMessages,
  addMessage,
  cacheParticipants,
  clearAuth,
  applyDelta,
  finalizeStreamingMessage,
  getStreamingMessages,
  setTyping,
  getTypingStates,
  type ConversationInfo,
  type ChatMessage,
} from '../store';
import { connectWs, disconnectWs, sendWsEvent, onWsEvent, onWsConnect } from '../ws';
import { listParticipants, getConversationMembers } from '../api';

export default function ChatPage() {
  const store = useStore();
  const { user, token, conversations, activeConversationId, messages, streamingMessages, typingStates, participantCache } = store;

  useEffect(() => {
    if (!token) return;

    // Connect WebSocket
    connectWs(token);

    // Listen for server events
    const unsub = onWsEvent((event) => {
      switch (event.type) {
        case 'conversations':
          setConversations((event as any).conversations ?? []);
          break;
        case 'conversation_created': {
          const conv = (event as any).conversation as ConversationInfo;
          if (conv) addConversation(conv);
          break;
        }
        case 'history':
          if (event.conversationId && event.messages) {
            setMessages(event.conversationId, event.messages as ChatMessage[]);
          }
          break;
        case 'message':
          if (event.message) {
            addMessage(event.message as ChatMessage);
          }
          break;
        case 'message_delta':
          if (event.delta) {
            const d = event.delta as { messageId: string; senderId: string; content: string };
            applyDelta(event.conversationId!, d.messageId, d.senderId, d.content);
          }
          break;
        case 'message_done':
          if (event.messageId) {
            finalizeStreamingMessage(event.messageId, (event as any).message as ChatMessage | undefined);
          }
          break;
        case 'typing':
          if (event.conversationId && event.participantId) {
            setTyping(event.conversationId, event.participantId, (event.activity as string) ?? 'typing');
          }
          break;
        case 'error':
          console.error('[chat] server error:', event.error);
          break;
      }
    });

    // Request conversation list on every (re)connect
    const unsubConnect = onWsConnect(() => {
      sendWsEvent({ type: 'list_conversations' });
    });
    // Also send immediately (queued if not yet open)
    sendWsEvent({ type: 'list_conversations' });

    // Load all participants for display names
    listParticipants()
      .then((ps) => cacheParticipants(ps))
      .catch(() => {});

    return () => {
      unsub();
      unsubConnect();
      disconnectWs();
    };
  }, [token]);

  // When active conversation changes, load history
  useEffect(() => {
    if (!activeConversationId) return;
    sendWsEvent({ type: 'get_history', conversationId: activeConversationId, limit: 50 });

    // Load members for display names
    getConversationMembers(activeConversationId)
      .then((members) => cacheParticipants(members))
      .catch(() => {});
  }, [activeConversationId]);

  const activeMessages = activeConversationId
    ? messages.get(activeConversationId) ?? []
    : [];

  return (
    <div className="chat-layout">
      {/* Sidebar */}
      <aside className="sidebar">
        <div className="sidebar-header">
          <div className="user-info">
            <span className="user-avatar">{user?.displayName?.charAt(0) ?? '?'}</span>
            <span className="user-name">{user?.displayName}</span>
          </div>
          <button className="btn-icon" title="Logout" onClick={() => { disconnectWs(); clearAuth(); }}>
            ⏻
          </button>
        </div>
        <NewConversationButton currentUserId={user?.id ?? ''} participantCache={participantCache} />
        <div className="conversation-list">
          {conversations.map((c) => (
            <ConversationItem
              key={c.id}
              conv={c}
              active={c.id === activeConversationId}
              onClick={() => setActiveConversation(c.id)}
            />
          ))}
          {conversations.length === 0 && (
            <div className="empty-hint">No conversations yet</div>
          )}
        </div>
      </aside>

      {/* Main chat area */}
      <main className="chat-main">
        {activeConversationId ? (
          <>
            <ChatHeader
              conv={conversations.find((c) => c.id === activeConversationId)}
            />
            <MessageList
              messages={activeMessages}
              conversationId={activeConversationId}
              currentUserId={user?.id ?? ''}
              participantCache={participantCache}
              streamingMessages={streamingMessages}
              typingStates={typingStates}
            />
            <MessageInput conversationId={activeConversationId} />
          </>
        ) : (
          <div className="no-chat-selected">
            <p>Select a conversation or create a new one</p>
          </div>
        )}
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ConversationItem({
  conv,
  active,
  onClick,
}: {
  conv: ConversationInfo;
  active: boolean;
  onClick: () => void;
}) {
  // Try to show the other participant's name for direct chats
  const label = conv.title || conv.label || 'Chat';
  return (
    <div className={`conv-item ${active ? 'active' : ''}`} onClick={onClick}>
      <div className="conv-label">{label}</div>
      {conv.lastMessage && (
        <div className="conv-preview">{conv.lastMessage}</div>
      )}
    </div>
  );
}

function ChatHeader({
  conv,
}: {
  conv?: ConversationInfo;
}) {
  return (
    <div className="chat-header">
      <h2>{conv?.title || 'Chat'}</h2>
    </div>
  );
}

function MessageList({
  messages,
  conversationId,
  currentUserId,
  participantCache,
  streamingMessages,
  typingStates,
}: {
  messages: ChatMessage[];
  conversationId: string;
  currentUserId: string;
  participantCache: Map<string, any>;
  streamingMessages: Map<string, any>;
  typingStates: Map<string, any>;
}) {
  const bottomRef = useRef<HTMLDivElement>(null);
  const streaming = getStreamingMessages(conversationId);
  const typing = getTypingStates(conversationId);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, streaming.length, typing.length]);

  return (
    <div className="message-list">
      {/* Completed messages */}
      {messages.map((m) => {
        const isOwn = m.senderId === currentUserId;
        const senderName = participantCache.get(m.senderId)?.displayName ?? m.senderId.slice(0, 8);
        const isAgent = participantCache.get(m.senderId)?.type === 'agent';
        return (
          <div key={m.id} className={`message-row ${isOwn ? 'own' : 'other'}`}>
            {!isOwn && (
              <div className="message-sender">
                {senderName}
                {isAgent && <span className="agent-badge">agent</span>}
              </div>
            )}
            <div className={`message-bubble ${isOwn ? 'own' : 'other'}`}>
              {m.content}
            </div>
            <div className="message-time">
              {new Date(m.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </div>
          </div>
        );
      })}

      {/* Streaming messages (in-progress) */}
      {streaming.map((sm) => {
        const senderName = participantCache.get(sm.senderId)?.displayName ?? sm.senderId.slice(0, 8);
        const isAgent = participantCache.get(sm.senderId)?.type === 'agent';
        return (
          <div key={`stream-${sm.id}`} className="message-row other">
            <div className="message-sender">
              {senderName}
              {isAgent && <span className="agent-badge">agent</span>}
            </div>
            <div className="message-bubble other streaming">
              {sm.content}
              <span className="streaming-cursor" />
            </div>
          </div>
        );
      })}

      {/* Typing indicators */}
      {typing.length > 0 && (
        <div className="typing-indicator">
          {typing.map((t) => {
            const name = participantCache.get(t.participantId)?.displayName ?? '...';
            const activityLabel = t.activity === 'thinking' ? 'thinking'
              : t.activity === 'tool_calling' ? 'using tools'
              : 'typing';
            return (
              <span key={t.participantId} className="typing-entry">
                {name} is {activityLabel}
              </span>
            );
          })}
          <span className="typing-dots"><span>.</span><span>.</span><span>.</span></span>
        </div>
      )}

      <div ref={bottomRef} />
    </div>
  );
}

function MessageInput({ conversationId }: { conversationId: string }) {
  const [text, setText] = useState('');

  const send = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    sendWsEvent({
      type: 'send_message',
      conversationId,
      content: trimmed,
      contentType: 'text',
    });
    setText('');
  };

  return (
    <div className="message-input-bar">
      <input
        type="text"
        placeholder="Type a message..."
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            send();
          }
        }}
        autoFocus
      />
      <button className="btn-send" onClick={send}>
        Send
      </button>
    </div>
  );
}

function NewConversationButton({
  currentUserId,
  participantCache,
}: {
  currentUserId: string;
  participantCache: Map<string, any>;
}) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [targetName, setTargetName] = useState('');
  const [error, setError] = useState('');

  // Refresh participant cache every time the form opens
  useEffect(() => {
    if (open) {
      listParticipants()
        .then((ps) => cacheParticipants(ps))
        .catch(() => {});
    }
  }, [open]);

  const handleCreate = async () => {
    setError('');
    // Refresh cache before lookup to catch recently registered agents
    let allParticipants = Array.from(participantCache.values());
    try {
      const fresh = await listParticipants();
      cacheParticipants(fresh);
      allParticipants = fresh; // use fresh data directly (closure captures stale prop)
    } catch { /* use stale cache as fallback */ }

    // Find the target participant
    const target = allParticipants.find(
      (p) => p.name === targetName || p.displayName === targetName
    );

    if (!target) {
      setError(`User "${targetName}" not found`);
      return;
    }

    if (target.id === currentUserId) {
      setError("Can't chat with yourself");
      return;
    }

    sendWsEvent({
      type: 'create_conversation',
      title: title || `Chat with ${target.displayName}`,
      participantIds: [currentUserId, target.id],
    });

    setOpen(false);
    setTitle('');
    setTargetName('');
  };

  if (!open) {
    return (
      <button className="btn-new-chat" onClick={() => setOpen(true)}>
        + New Chat
      </button>
    );
  }

  return (
    <div className="new-chat-form">
      <input
        type="text"
        placeholder="Username to chat with"
        value={targetName}
        onChange={(e) => setTargetName(e.target.value)}
        autoFocus
      />
      <input
        type="text"
        placeholder="Chat title (optional)"
        value={title}
        onChange={(e) => setTitle(e.target.value)}
      />
      {error && <div className="error-msg">{error}</div>}
      <div className="form-actions">
        <button className="btn-primary" onClick={handleCreate}>Create</button>
        <button className="btn-secondary" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  );
}
