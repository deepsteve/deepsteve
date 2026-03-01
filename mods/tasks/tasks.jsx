const { useState, useEffect, useCallback } = React;

const PRIORITY_COLORS = {
  high: '#f85149',
  medium: '#f0883e',
  low: '#8b949e',
};

const STATUS_OPTIONS = ['all', 'pending', 'in-progress', 'done'];

function renderOlGroup(items) {
  const result = [];
  let i = 0;
  const baseIndent = items[0].indent;
  while (i < items.length) {
    const item = items[i];
    if (item.indent > baseIndent) {
      // Collect all consecutive items with indent > baseIndent as a nested group
      const nested = [];
      while (i < items.length && items[i].indent > baseIndent) {
        nested.push(items[i]);
        i++;
      }
      // Append nested <ol> inside the previous <li>
      if (result.length > 0) {
        const prev = result[result.length - 1];
        result[result.length - 1] = (
          <li key={prev.key} style={{ padding: '1px 0' }}>
            {prev.props.children}
            {renderOlGroup(nested)}
          </li>
        );
      } else {
        // Nested items with no parent — render them as a standalone nested list
        result.push(renderOlGroup(nested));
      }
    } else {
      result.push(
        <li key={item.lineIndex} style={{ padding: '1px 0' }}>{item.text}</li>
      );
      i++;
    }
  }
  return (
    <ol style={{ margin: '2px 0', paddingLeft: 20, listStyleType: 'decimal' }}>
      {result}
    </ol>
  );
}

function renderDescription(description, onCheckToggle) {
  if (!description) return null;
  const lines = description.split('\n');
  const checklistRe = /^- \[([ xX])\] (.*)$/;
  const orderedRe = /^(\s*)(\d+)\.\s+(.*)$/;

  const elements = [];
  let olBuffer = [];

  function flushOl() {
    if (olBuffer.length === 0) return;
    elements.push(
      <React.Fragment key={`ol-${olBuffer[0].lineIndex}`}>
        {renderOlGroup(olBuffer)}
      </React.Fragment>
    );
    olBuffer = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Ordered list item
    const olMatch = line.match(orderedRe);
    if (olMatch) {
      olBuffer.push({ indent: olMatch[1].length, text: olMatch[3], lineIndex: i });
      continue;
    }

    // Flush any pending OL items before rendering a non-OL line
    flushOl();

    // Checkbox line
    const checkMatch = line.match(checklistRe);
    if (checkMatch) {
      const checked = checkMatch[1] !== ' ';
      const text = checkMatch[2];
      elements.push(
        <label key={i} style={{
          display: 'flex',
          alignItems: 'flex-start',
          gap: 5,
          padding: '1px 0',
          cursor: 'pointer',
        }}>
          <input
            type="checkbox"
            checked={checked}
            onChange={() => onCheckToggle(i)}
            style={{ marginTop: 2, accentColor: '#238636', cursor: 'pointer', flexShrink: 0 }}
          />
          <span style={{
            textDecoration: checked ? 'line-through' : 'none',
            opacity: checked ? 0.6 : 1,
          }}>
            {text}
          </span>
        </label>
      );
      continue;
    }

    // Plain text or empty line
    elements.push(
      line ? <div key={i}>{line}</div> : <div key={i} style={{ height: 4 }} />
    );
  }

  flushOl();

  return (
    <div style={{ fontSize: 12, color: '#8b949e', marginTop: 3, wordBreak: 'break-word' }}>
      {elements}
    </div>
  );
}

function TaskItem({ task, compact, onToggle, onDelete, onDescriptionUpdate }) {
  const isDone = task.status === 'done';

  const handleCheckToggle = useCallback((lineIndex) => {
    const lines = task.description.split('\n');
    const checklistRe = /^- \[([ xX])\] (.*)$/;
    const m = lines[lineIndex].match(checklistRe);
    if (!m) return;
    const checked = m[1] !== ' ';
    lines[lineIndex] = `- [${checked ? ' ' : 'x'}] ${m[2]}`;
    onDescriptionUpdate(task.id, lines.join('\n'));
  }, [task.id, task.description, onDescriptionUpdate]);

  return (
    <div style={{
      padding: compact ? '5px 12px' : '10px 12px',
      borderBottom: '1px solid rgba(255,255,255,0.06)',
      opacity: isDone ? 0.5 : 1,
      display: 'flex',
      alignItems: 'flex-start',
      gap: 8,
    }}>
      <input
        type="checkbox"
        checked={isDone}
        onChange={() => onToggle(task.id, isDone ? 'pending' : 'done')}
        style={{ marginTop: 3, accentColor: '#238636', cursor: 'pointer', flexShrink: 0 }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 13,
          color: isDone ? '#8b949e' : '#c9d1d9',
          textDecoration: isDone ? 'line-through' : 'none',
          wordBreak: 'break-word',
        }}>
          {task.title}
        </div>
        {!compact && renderDescription(task.description, handleCheckToggle)}
        {!compact && (
          <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
            {task.priority && (
              <span style={{
                fontSize: 10,
                padding: '1px 6px',
                borderRadius: 8,
                background: 'rgba(255,255,255,0.06)',
                color: PRIORITY_COLORS[task.priority] || '#8b949e',
                border: `1px solid ${PRIORITY_COLORS[task.priority] || '#30363d'}33`,
              }}>
                {task.priority}
              </span>
            )}
            {task.session_tag && (
              <span style={{
                fontSize: 10,
                padding: '1px 6px',
                borderRadius: 8,
                background: 'rgba(88,166,255,0.1)',
                color: '#58a6ff',
                border: '1px solid rgba(88,166,255,0.2)',
              }}>
                {task.session_tag}
              </span>
            )}
            {task.status === 'in-progress' && (
              <span style={{
                fontSize: 10,
                padding: '1px 6px',
                borderRadius: 8,
                background: 'rgba(240,136,62,0.1)',
                color: '#f0883e',
                border: '1px solid rgba(240,136,62,0.2)',
              }}>
                in progress
              </span>
            )}
          </div>
        )}
      </div>
      <button
        onClick={() => onDelete(task.id)}
        style={{
          background: 'none',
          border: 'none',
          color: '#8b949e',
          cursor: 'pointer',
          fontSize: 14,
          padding: '0 4px',
          opacity: 0.5,
          flexShrink: 0,
        }}
        onMouseEnter={e => e.target.style.opacity = 1}
        onMouseLeave={e => e.target.style.opacity = 0.5}
        title="Delete task"
      >
        &#10005;
      </button>
    </div>
  );
}

function TasksPanel() {
  const [tasks, setTasks] = useState([]);
  const [filter, setFilter] = useState('all');
  const [tagFilter, setTagFilter] = useState('all');
  const [compactView, setCompactView] = useState(false);

  useEffect(() => {
    let unsubTasks = null;
    let unsubSettings = null;

    function setup() {
      unsubTasks = window.deepsteve.onTasksChanged((newTasks) => {
        setTasks(newTasks || []);
      });

      // Restore persisted settings
      const settings = window.deepsteve.getSettings();
      if (settings.compactView != null) setCompactView(settings.compactView);
      if (settings.statusFilter != null) setFilter(settings.statusFilter);
      if (settings.tagFilter != null) setTagFilter(settings.tagFilter);

      // React to settings changes (e.g. toggled from settings panel)
      unsubSettings = window.deepsteve.onSettingsChanged((settings) => {
        if (settings.compactView != null) setCompactView(settings.compactView);
        if (settings.statusFilter != null) setFilter(settings.statusFilter);
        if (settings.tagFilter != null) setTagFilter(settings.tagFilter);
      });
    }

    // Bridge API is injected by the parent after iframe load event,
    // so it may not be available yet when this effect runs. Poll for it.
    if (window.deepsteve) {
      setup();
    } else {
      let attempts = 0;
      const poll = setInterval(() => {
        if (window.deepsteve) {
          clearInterval(poll);
          setup();
        } else if (++attempts > 100) {
          clearInterval(poll);
        }
      }, 100);
    }

    return () => {
      if (unsubTasks) unsubTasks();
      if (unsubSettings) unsubSettings();
    };
  }, []);

  const toggleStatus = useCallback(async (id, newStatus) => {
    try {
      await fetch(`/api/tasks/${id}/status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: newStatus }),
      });
    } catch (e) {
      console.error('Failed to update task:', e);
    }
  }, []);

  const deleteTask = useCallback(async (id) => {
    try {
      await fetch(`/api/tasks/${id}`, { method: 'DELETE' });
    } catch (e) {
      console.error('Failed to delete task:', e);
    }
  }, []);

  const updateDescription = useCallback(async (id, description) => {
    try {
      await fetch(`/api/tasks/${id}/description`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description }),
      });
    } catch (e) {
      console.error('Failed to update description:', e);
    }
  }, []);

  const handleFilterChange = useCallback((s) => {
    setFilter(s);
    if (window.deepsteve) window.deepsteve.updateSetting('statusFilter', s);
  }, []);

  const handleTagFilterChange = useCallback((t) => {
    setTagFilter(t);
    if (window.deepsteve) window.deepsteve.updateSetting('tagFilter', t);
  }, []);

  const toggleCompactView = useCallback(() => {
    setCompactView(prev => {
      const next = !prev;
      if (window.deepsteve) window.deepsteve.updateSetting('compactView', next);
      return next;
    });
  }, []);

  // Get unique session tags for filter dropdown
  const tags = [...new Set(tasks.map(t => t.session_tag).filter(Boolean))];

  // Apply filters
  let filtered = tasks;
  if (filter !== 'all') filtered = filtered.filter(t => t.status === filter);
  if (tagFilter !== 'all') filtered = filtered.filter(t => t.session_tag === tagFilter);

  // Sort: pending first, then in-progress, then done
  const statusOrder = { 'pending': 0, 'in-progress': 1, 'done': 2 };
  filtered = [...filtered].sort((a, b) => (statusOrder[a.status] || 0) - (statusOrder[b.status] || 0));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
      {/* Header */}
      <div style={{
        padding: '12px 12px 8px',
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        flexShrink: 0,
      }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: '#f0f6fc', marginBottom: 8, display: 'flex', alignItems: 'center' }}>
          <span>
            Tasks
            {tasks.length > 0 && (
              <span style={{ fontSize: 12, color: '#8b949e', fontWeight: 400, marginLeft: 6 }}>
                {tasks.filter(t => t.status !== 'done').length} pending
              </span>
            )}
          </span>
          <button
            onClick={toggleCompactView}
            style={{
              marginLeft: 'auto',
              background: 'none',
              border: 'none',
              color: compactView ? '#58a6ff' : '#8b949e',
              cursor: 'pointer',
              fontSize: 14,
              padding: '0 2px',
              lineHeight: 1,
            }}
            title={compactView ? 'Expand view' : 'Compact view'}
          >
            &#9776;
          </button>
        </div>

        {/* Status filter */}
        <div style={{ display: 'flex', gap: 2, marginBottom: tags.length > 0 ? 6 : 0 }}>
          {STATUS_OPTIONS.map(s => (
            <button
              key={s}
              onClick={() => handleFilterChange(s)}
              style={{
                padding: '3px 8px',
                fontSize: 11,
                border: 'none',
                borderRadius: 4,
                cursor: 'pointer',
                background: filter === s ? '#58a6ff' : 'rgba(255,255,255,0.06)',
                color: filter === s ? '#fff' : '#8b949e',
              }}
            >
              {s}
            </button>
          ))}
        </div>

        {/* Session tag filter */}
        {tags.length > 0 && (
          <select
            value={tagFilter}
            onChange={e => handleTagFilterChange(e.target.value)}
            style={{
              width: '100%',
              padding: '4px 8px',
              fontSize: 11,
              background: '#0d1117',
              border: '1px solid #30363d',
              borderRadius: 4,
              color: '#c9d1d9',
              cursor: 'pointer',
            }}
          >
            <option value="all">All sessions</option>
            {tags.map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        )}
      </div>

      {/* Task list */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {filtered.length === 0 ? (
          <div style={{
            padding: 24,
            textAlign: 'center',
            color: '#8b949e',
            fontSize: 13,
          }}>
            {tasks.length === 0
              ? 'No tasks yet. Claude sessions can create tasks via MCP tools.'
              : 'No tasks match the current filter.'}
          </div>
        ) : (
          filtered.map(task => (
            <TaskItem
              key={task.id}
              task={task}
              compact={compactView}
              onToggle={toggleStatus}
              onDelete={deleteTask}
              onDescriptionUpdate={updateDescription}
            />
          ))
        )}
      </div>
    </div>
  );
}

const root = ReactDOM.createRoot(document.getElementById('tasks-root'));
root.render(<TasksPanel />);
