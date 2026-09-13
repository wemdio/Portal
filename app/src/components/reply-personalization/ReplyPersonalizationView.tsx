'use client';

import { useState } from 'react';
import { KnowledgeBaseForm } from './KnowledgeBaseForm';
import { ProjectInbox } from './ProjectInbox';
import { ProjectPicker } from './ProjectPicker';
import type { ProjectListItem } from './api';

type Mode = 'inbox' | 'settings';

export function ReplyPersonalizationView() {
  const [project, setProject] = useState<ProjectListItem | null>(null);
  const [mode, setMode] = useState<Mode>('inbox');

  if (!project) {
    return (
      <ProjectPicker
        onSelect={(p) => {
          setProject(p);
          setMode(p.hasKnowledgeBase ? 'inbox' : 'settings');
        }}
      />
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-zinc-200 bg-white px-4 py-2">
        <div className="flex items-center gap-3">
          <button type="button" onClick={() => setProject(null)} className="text-sm text-zinc-500 hover:text-zinc-700">
            ← Все проекты
          </button>
          <span className="text-sm font-medium text-zinc-900">{project.client}</span>
        </div>
        <button
          type="button"
          onClick={() => setMode(mode === 'inbox' ? 'settings' : 'inbox')}
          className="text-sm text-zinc-500 hover:text-zinc-700"
        >
          {mode === 'inbox' ? 'Настроить базу знаний' : 'К письмам'}
        </button>
      </div>

      <div className="flex-1 min-h-0">
        {mode === 'settings' ? (
          <KnowledgeBaseForm projectId={project.id} onClose={() => setMode('inbox')} />
        ) : (
          <ProjectInbox projectId={project.id} />
        )}
      </div>
    </div>
  );
}
