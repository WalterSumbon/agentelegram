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
  setConversationMembers,
  getConversationMembersList,
  type ConversationInfo,
  type ChatMessage,
  type User,
} from '../store';
import { connectWs, disconnectWs, sendWsEvent, onWsEvent, onWsConnect } from '../ws';
import { listParticipants, getConversationMembers } from '../api';
import { AgentList, AgentManagementPanel } from './AgentPanel';

type SidebarMode = 'chats' | 'agents';

export default function ChatPage() {
  const store = useStore();
  const { user, token, conversations, activeConversationId, messages, streamingMessages, typingStates, participantCache } = store;
  const [sidebarMode, setSidebarMode] = useState<SidebarMode>('chats');
  const [selectedAgentId, setSelectedAgentId] = useState<string | null>(null);

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
          if (conv) {
            addConversation(conv);
            // Auto-select if this user created the conversation
            if (conv.createdBy === user?.id) {
              setActiveConversation(conv.id);
            }
          }
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
      .catch((err) => console.error('[chat]', err));

    return () => {
      unsub();
      unsubConnect();
      disconnectWs();
    };
  }, [token]);

  // When active conversation changes, load history + members
  useEffect(() => {
    if (!activeConversationId) return;
    sendWsEvent({ type: 'get_history', conversationId: activeConversationId, limit: 50 });

    // Load members for display names and group header
    getConversationMembers(activeConversationId)
      .then((members) => {
        cacheParticipants(members);
        setConversationMembers(activeConversationId, members);
      })
      .catch((err) => console.error('[chat]', err));
  }, [activeConversationId]);

  const activeMessages = activeConversationId
    ? messages.get(activeConversationId) ?? []
    : [];

  const activeConv = conversations.find((c) => c.id === activeConversationId);

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

        {/* Sidebar mode tabs */}
        <div className="sidebar-tabs">
          <button
            className={`sidebar-tab ${sidebarMode === 'chats' ? 'active' : ''}`}
            onClick={() => setSidebarMode('chats')}
          >
            Chats
          </button>
          <button
            className={`sidebar-tab ${sidebarMode === 'agents' ? 'active' : ''}`}
            onClick={() => setSidebarMode('agents')}
          >
            Agents
          </button>
        </div>

        {sidebarMode === 'chats' ? (
          <>
            <NewConversationButton currentUserId={user?.id ?? ''} participantCache={participantCache} />
            <div className="conversation-list">
              {conversations.map((c) => (
                <ConversationItem
                  key={c.id}
                  conv={c}
                  active={c.id === activeConversationId}
                  onClick={() => setActiveConversation(c.id)}
                  participantCache={participantCache}
                  currentUserId={user?.id ?? ''}
                />
              ))}
              {conversations.length === 0 && (
                <div className="empty-hint">No conversations yet</div>
              )}
            </div>
          </>
        ) : (
          <div className="conversation-list">
            <AgentList
              selectedAgentId={selectedAgentId}
              onSelect={(id) => setSelectedAgentId(id)}
            />
          </div>
        )}
      </aside>

      {/* Main content area */}
      <main className="chat-main">
        {sidebarMode === 'agents' ? (
          selectedAgentId ? (
            <AgentManagementPanel agentId={selectedAgentId} />
          ) : (
            <div className="no-chat-selected">
              <p>Select an agent to manage</p>
            </div>
          )
        ) : activeConversationId ? (
          <>
            <ChatHeader
              conv={activeConv}
              conversationId={activeConversationId}
              currentUserId={user?.id ?? ''}
              participantCache={participantCache}
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
  participantCache,
  currentUserId,
}: {
  conv: ConversationInfo;
  active: boolean;
  onClick: () => void;
  participantCache: Map<string, User>;
  currentUserId: string;
}) {
  const isGroup = conv.type === 'group';
  const members = getConversationMembersList(conv.id);
  const otherMembers = members.filter((m) => m.id !== currentUserId);

  // Label: title if set, else member names
  let label = conv.title || conv.label;
  if (!label && otherMembers.length > 0) {
    label = otherMembers.map((m) => m.displayName).join(', ');
  }
  if (!label) label = 'Chat';

  return (
    <div className={`conv-item ${active ? 'active' : ''}`} onClick={onClick}>
      <div className="conv-item-header">
        {isGroup && <span className="group-icon" title="Group chat">👥</span>}
        <div className="conv-label">{label}</div>
        {isGroup && members.length > 0 && (
          <span className="member-count">{members.length}</span>
        )}
      </div>
      {conv.lastMessage && (
        <div className="conv-preview">{conv.lastMessage}</div>
      )}
    </div>
  );
}

function ChatHeader({
  conv,
  conversationId,
  currentUserId,
  participantCache,
}: {
  conv?: ConversationInfo;
  conversationId: string;
  currentUserId: string;
  participantCache: Map<string, User>;
}) {
  const members = getConversationMembersList(conversationId);
  const otherMembers = members.filter((m) => m.id !== currentUserId);
  const isGroup = conv?.type === 'group';

  let title = conv?.title;
  if (!title && otherMembers.length > 0) {
    title = otherMembers.map((m) => m.displayName).join(', ');
  }
  if (!title) title = 'Chat';

  return (
    <div className="chat-header">
      <div className="chat-header-top">
        {isGroup && <span className="group-icon">👥</span>}
        <h2>{title}</h2>
      </div>
      {isGroup && members.length > 0 && (
        <div className="chat-header-members">
          {members.map((m) => (
            <span key={m.id} className={`member-chip ${m.type === 'agent' ? 'agent' : ''}`}>
              <span className="member-avatar">{m.displayName.charAt(0)}</span>
              {m.displayName}
              {m.type === 'agent' && <span className="agent-dot" />}
            </span>
          ))}
        </div>
      )}
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
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState<User[]>([]);
  const [error, setError] = useState('');

  // Refresh participant cache every time the form opens
  useEffect(() => {
    if (open) {
      listParticipants()
        .then((ps) => cacheParticipants(ps))
        .catch((err) => console.error('[chat]', err));
      // Reset form state
      setTitle('');
      setSearch('');
      setSelected([]);
      setError('');
    }
  }, [open]);

  // Available participants: everyone except current user and already selected
  const allParticipants = Array.from(participantCache.values()) as User[];
  const available = allParticipants.filter(
    (p) => p.id !== currentUserId && !selected.find((s) => s.id === p.id)
  );
  const filtered = search
    ? available.filter(
        (p) =>
          p.name.toLowerCase().includes(search.toLowerCase()) ||
          p.displayName.toLowerCase().includes(search.toLowerCase())
      )
    : available;

  const toggleSelect = (p: User) => {
    if (selected.find((s) => s.id === p.id)) {
      setSelected(selected.filter((s) => s.id !== p.id));
    } else {
      setSelected([...selected, p]);
    }
    setSearch('');
  };

  const removeSelected = (id: string) => {
    setSelected(selected.filter((s) => s.id !== id));
  };

  const handleCreate = () => {
    setError('');
    if (selected.length === 0) {
      setError('Select at least one participant');
      return;
    }

    const participantIds = [currentUserId, ...selected.map((s) => s.id)];
    const isGroup = selected.length > 1;
    const defaultTitle = isGroup
      ? selected.map((s) => s.displayName).join(', ')
      : `Chat with ${selected[0].displayName}`;

    sendWsEvent({
      type: 'create_conversation',
      title: title || defaultTitle,
      participantIds,
    });

    setOpen(false);
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
      {/* Selected participants chips */}
      {selected.length > 0 && (
        <div className="selected-chips">
          {selected.map((p) => (
            <span key={p.id} className={`chip ${p.type === 'agent' ? 'agent' : ''}`}>
              {p.displayName}
              {p.type === 'agent' && <span className="agent-dot" />}
              <button className="chip-remove" onClick={() => removeSelected(p.id)}>×</button>
            </span>
          ))}
        </div>
      )}

      {/* Search input */}
      <input
        type="text"
        placeholder={selected.length === 0 ? 'Search participants...' : 'Add more...'}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        autoFocus
      />

      {/* Available participants list */}
      <div className="participant-list">
        {filtered.length === 0 && (
          <div className="participant-empty">
            {search ? 'No matches' : 'No more participants'}
          </div>
        )}
        {filtered.slice(0, 10).map((p) => (
          <div key={p.id} className="participant-option" onClick={() => toggleSelect(p)}>
            <span className={`participant-avatar ${p.type === 'agent' ? 'agent' : ''}`}>
              {p.displayName.charAt(0)}
            </span>
            <div className="participant-info">
              <span className="participant-name">{p.displayName}</span>
              <span className="participant-type">@{p.name} · {p.type}</span>
            </div>
          </div>
        ))}
      </div>

      {/* Title input (shown when creating group) */}
      {selected.length > 1 && (
        <input
          type="text"
          placeholder="Group title (optional)"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
      )}

      {error && <div className="error-msg">{error}</div>}
      <div className="form-actions">
        <button className="btn-primary" onClick={handleCreate} disabled={selected.length === 0}>
          {selected.length > 1 ? 'Create Group' : 'Create Chat'}
        </button>
        <button className="btn-secondary" onClick={() => setOpen(false)}>Cancel</button>
      </div>
    </div>
  );
}
