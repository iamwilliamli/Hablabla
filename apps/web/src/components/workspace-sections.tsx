"use client";

import { Icon } from "@/components/icons";
import { ModelStatus } from "@/components/model-status";
import type { MeetingResult } from "@/lib/local-ai/result-schema";
import type { ModelSnapshot } from "@/lib/local-ai/model-runtime";
import type { Meeting } from "@/lib/meetings";

type RecapMap = Record<string, MeetingResult | undefined>;

function durationMinutes(duration: string) {
  return Number.parseInt(duration, 10) || 0;
}

export function WorkspaceOverview({
  meetings,
  recaps,
  onOpenMeeting,
  onOpenLibrary,
}: {
  meetings: Meeting[];
  recaps: RecapMap;
  onOpenMeeting: (id: string) => void;
  onOpenLibrary: () => void;
}) {
  const totalMinutes = meetings.reduce(
    (total, meeting) => total + durationMinutes(meeting.duration),
    0,
  );
  const actionCount = meetings.reduce(
    (total, meeting) => total + (recaps[meeting.id]?.actions.length ?? 0),
    0,
  );
  const maxMinutes = Math.max(
    1,
    ...meetings.map((meeting) => durationMinutes(meeting.duration)),
  );
  const categories = Array.from(new Set(meetings.map((meeting) => meeting.category)));
  const latest = meetings[0];

  return (
    <div className="workspace-section">
      <header className="section-page-heading">
        <div>
          <span className="page-eyebrow">YOUR WORKSPACE</span>
          <h1>Overview</h1>
          <p>Your meetings, decisions, and next steps in one place.</p>
        </div>
        <button className="button" onClick={onOpenLibrary}>
          View all meetings <Icon name="arrow" size={16} />
        </button>
      </header>

      <section className="overview-hero" aria-labelledby="week-heading">
        <div className="overview-hero-heading">
          <div>
            <span className="page-eyebrow">AT A GLANCE</span>
            <h2 id="week-heading">Your meeting activity</h2>
          </div>
          <span className="overview-date">This session</span>
        </div>
        <div className="overview-stats">
          <article>
            <span className="stat-icon stat-green"><Icon name="document" size={19} /></span>
            <strong>{meetings.length}</strong>
            <span>Meetings</span>
          </article>
          <article>
            <span className="stat-icon stat-blue"><Icon name="clock" size={19} /></span>
            <strong>{totalMinutes}</strong>
            <span>Minutes</span>
          </article>
          <article>
            <span className="stat-icon stat-gold"><Icon name="tasks" size={19} /></span>
            <strong>{actionCount}</strong>
            <span>Action items</span>
          </article>
        </div>
        <div className="activity-bars" aria-label="Meeting durations">
          {meetings.map((meeting) => (
            <button
              key={meeting.id}
              onClick={() => onOpenMeeting(meeting.id)}
              title={`${meeting.title}: ${meeting.duration}`}
            >
              <span
                style={{ height: `${Math.max(18, (durationMinutes(meeting.duration) / maxMinutes) * 100)}%` }}
              />
              <small>{meeting.date.split(" ")[0].slice(0, 3)}</small>
            </button>
          ))}
        </div>
      </section>

      <div className="overview-grid">
        {latest && (
          <section className="latest-meeting" aria-labelledby="latest-heading">
            <div className="card-heading">
              <span className="card-icon"><Icon name="document" size={20} /></span>
              <div>
                <span className="page-eyebrow">LATEST MEETING</span>
                <h2 id="latest-heading">{latest.title}</h2>
              </div>
            </div>
            <p>{recaps[latest.id]?.summary ?? "Open this meeting to read the transcript and review its summary."}</p>
            <div className="latest-meta">
              <span><Icon name="calendar" size={14} />{latest.date}</span>
              <span><Icon name="clock" size={14} />{latest.duration}</span>
            </div>
            <button className="button primary" onClick={() => onOpenMeeting(latest.id)}>
              Open meeting <Icon name="arrow" size={16} />
            </button>
          </section>
        )}
        <section className="category-card" aria-labelledby="category-heading">
          <div className="card-heading">
            <span className="card-icon"><Icon name="grid" size={20} /></span>
            <div>
              <span className="page-eyebrow">ORGANIZED FOR YOU</span>
              <h2 id="category-heading">Meeting categories</h2>
            </div>
          </div>
          <div className="category-list">
            {categories.map((category) => {
              const count = meetings.filter((meeting) => meeting.category === category).length;
              return (
                <button key={category} onClick={onOpenLibrary}>
                  <span>{category}</span><strong>{count}</strong><Icon name="chevron" size={14} />
                </button>
              );
            })}
          </div>
        </section>
      </div>
    </div>
  );
}

export function RecordingsLibrary({
  meetings,
  category,
  onCategoryChange,
  onOpenMeeting,
}: {
  meetings: Meeting[];
  category: string;
  onCategoryChange: (category: string) => void;
  onOpenMeeting: (id: string) => void;
}) {
  const categories = ["All", ...Array.from(new Set(meetings.map((meeting) => meeting.category)))];
  const visible = category === "All"
    ? meetings
    : meetings.filter((meeting) => meeting.category === category);

  return (
    <div className="workspace-section">
      <header className="section-page-heading">
        <div>
          <span className="page-eyebrow">YOUR LIBRARY</span>
          <h1>Recordings</h1>
          <p>Browse imported transcripts and sample meetings.</p>
        </div>
      </header>
      <div className="filter-chips" aria-label="Filter recordings by category">
        {categories.map((item) => (
          <button
            key={item}
            className={category === item ? "active" : ""}
            aria-pressed={category === item}
            onClick={() => onCategoryChange(item)}
          >
            {item === "All" && <Icon name="grid" size={15} />}{item}
          </button>
        ))}
      </div>
      <div className="recording-list">
        {visible.map((meeting) => (
          <button key={meeting.id} className="recording-card" onClick={() => onOpenMeeting(meeting.id)}>
            <div className="recording-card-top">
              <span className="card-icon"><Icon name="document" size={19} /></span>
              <span className="recording-kind">{meeting.sample ? "Sample" : "Your meeting"}</span>
              <span className="duration-pill">{meeting.duration}</span>
            </div>
            <h2>{meeting.title}</h2>
            <span className="recording-date">{meeting.date} · {meeting.time}</span>
            <p>{meeting.transcript.split("\n\n")[0].replace(/^.*?\]:\s*/, "")}</p>
            <div className="recording-tags">
              <span>{meeting.category}</span>
              <span>{meeting.participants.length || "Text"} {meeting.participants.length === 1 ? "person" : meeting.participants.length ? "people" : "transcript"}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}

export function WorkspaceSettings({
  model,
  darkTheme,
  onDarkThemeChange,
  textSize,
  onTextSizeChange,
  onAddMeeting,
  onShowPrivacy,
}: {
  model: ModelSnapshot;
  darkTheme: boolean;
  onDarkThemeChange: (enabled: boolean) => void;
  textSize: number;
  onTextSizeChange: (size: number) => void;
  onAddMeeting: () => void;
  onShowPrivacy: () => void;
}) {
  return (
    <div className="workspace-section settings-page">
      <header className="section-page-heading">
        <div>
          <span className="page-eyebrow">YOUR PREFERENCES</span>
          <h1>Settings</h1>
          <p>Make the workspace comfortable and understand how your data is handled.</p>
        </div>
      </header>

      <section className="settings-group" aria-labelledby="display-settings">
        <h2 id="display-settings">Appearance</h2>
        <label className="setting-row">
          <span className="settings-row-icon"><Icon name="spark" size={20} /></span>
          <span><strong>Dark theme</strong><small>Use darker colors throughout the workspace.</small></span>
          <input
            type="checkbox"
            role="switch"
            checked={darkTheme}
            onChange={(event) => onDarkThemeChange(event.target.checked)}
          />
        </label>
        <div className="setting-row text-size-setting">
          <span className="settings-row-icon"><Icon name="grid" size={20} /></span>
          <span><strong>Text size</strong><small>Adjust text throughout the workspace.</small></span>
          <output htmlFor="text-size-slider">{textSize}px</output>
          <input
            id="text-size-slider"
            type="range"
            min="12"
            max="18"
            step="1"
            value={textSize}
            aria-label="Workspace text size"
            aria-valuetext={`${textSize} pixels`}
            onChange={(event) => onTextSizeChange(Number(event.target.value))}
          />
          <span className="text-size-scale" aria-hidden="true"><small>Smaller</small><small>Larger</small></span>
        </div>
      </section>

      <section className="settings-group" aria-labelledby="ai-settings">
        <h2 id="ai-settings">Private AI</h2>
        <ModelStatus model={model} />
        <div className="setting-information">
          <Icon name="spark" size={20} />
          <span><strong>Smart organization</strong><small>Recaps separate decisions, action items, and open questions.</small></span>
        </div>
        <div className="setting-information">
          <Icon name="lock" size={20} />
          <span><strong>Local model</strong><small>Meeting text is analyzed in this browser using WebGPU.</small></span>
        </div>
      </section>

      <section className="settings-group" aria-labelledby="workspace-settings">
        <h2 id="workspace-settings">Workspace</h2>
        <button className="setting-row" onClick={onAddMeeting}>
          <span className="settings-row-icon"><Icon name="plus" size={20} /></span>
          <span><strong>Add a meeting</strong><small>Paste a transcript or meeting notes.</small></span>
          <Icon name="chevron" size={17} />
        </button>
        <button className="setting-row" onClick={onShowPrivacy}>
          <span className="settings-row-icon"><Icon name="help" size={20} /></span>
          <span><strong>How it works</strong><small>Learn about local AI, storage, and task approval.</small></span>
          <Icon name="chevron" size={17} />
        </button>
        <button className="setting-row" onClick={onShowPrivacy}>
          <span className="settings-row-icon"><Icon name="lock" size={20} /></span>
          <span><strong>Privacy</strong><small>See what stays in your browser and what can be saved.</small></span>
          <Icon name="chevron" size={17} />
        </button>
      </section>
    </div>
  );
}
