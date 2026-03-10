/* eslint-disable @next/next/no-img-element */
'use client';

import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { usePathname } from 'next/navigation';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  useDroppable,
  useDraggable,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { supabase } from '@/lib/supabaseClient';
import { Project, Task, TaskBoard, TaskBoardColumn, TaskStatus, UserRole } from '@/types';
import { logError } from '@/lib/loggerClient';
import { useIsTma } from '@/lib/useIsTma';
import { isLead as checkIsLead } from '@/lib/roles';

const DEFAULT_BOARD_ID = '00000000-0000-0000-0000-000000000001';
const COLUMN_DRAG_PREFIX = 'column-';

type ProfileOption = {
  id: string;
  fullName: string;
  nickname: string; // email local-part, used as display handle
  email: string;
  role: UserRole | null;
  avatarUrl: string | null;
  initials: string;
  color: string;
  /** value stored in tasks.specialist */
  value: string;
};

const ROLE_LABELS: Partial<Record<UserRole, string>> = {
  admin: 'Адм.',
  lead: 'Лид',
  manager: 'Менеджер',
  director: 'Директор',
  sales: 'Продажи',
  marketer: 'Маркетолог',
  technician: 'Техник',
};

const AVATAR_PALETTE = ['#3b82f6','#8b5cf6','#10b981','#f59e0b','#f43f5e','#06b6d4','#ec4899','#14b8a6'];

function profileAvatarColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return AVATAR_PALETTE[Math.abs(h) % AVATAR_PALETTE.length];
}

function buildProfileOption(raw: { id: string; full_name?: string | null; email?: string | null; role?: string | null; avatar_url?: string | null }): ProfileOption {
  const fullName = raw.full_name?.trim() ?? '';
  const email = raw.email?.trim() ?? '';
  const nickname = email.split('@')[0] ?? fullName;
  const value = fullName || nickname;
  const initials = (fullName || nickname).slice(0, 2).toUpperCase();
  return {
    id: raw.id,
    fullName,
    nickname,
    email,
    role: (raw.role as UserRole) ?? null,
    avatarUrl: raw.avatar_url ?? null,
    initials,
    color: profileAvatarColor(raw.id),
    value,
  };
}

const TASK_STATUS_CONFIG: Record<TaskStatus, { label: string; className: string }> = {
  pending: { label: 'Ожидает', className: 'bg-gray-100 text-gray-600 border-gray-200' },
  in_progress: { label: 'В работе', className: 'bg-blue-50 text-blue-700 border-blue-200' },
  done: { label: 'Завершено', className: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
};

const splitLegacyTasks = (value: string | null | undefined) => {
  if (!value) return [];
  return value
    .split(/\r?\n|•|;+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
};

type EnrichedTask = Task & {
  projectName: string;
  specialistName: string;
  isLegacy?: boolean;
};

function DroppableColumn({
  columnId,
  children,
  baseClassName,
}: {
  columnId: string;
  children: React.ReactNode;
  baseClassName?: string;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: columnId });
  const className = `${baseClassName ?? ''} ${isOver ? 'ring-2 ring-blue-400 ring-inset rounded-xl bg-blue-50/50' : ''}`.trim();
  return (
    <div ref={setNodeRef} className={className} data-droppable>
      {children}
    </div>
  );
}

function DraggableTaskCard({ task, children }: { task: EnrichedTask; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: task.id });
  return (
    <div ref={setNodeRef} {...listeners} {...attributes} className={isDragging ? 'opacity-50' : ''}>
      {children}
    </div>
  );
}

function DraggableColumnHeader({ column, children }: { column: TaskBoardColumn; children: React.ReactNode }) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: COLUMN_DRAG_PREFIX + column.id,
  });
  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      className={`flex min-w-0 flex-1 items-center gap-1 ${isDragging ? 'opacity-50' : ''} cursor-grab active:cursor-grabbing`}
    >
      {children}
    </div>
  );
}

export default function TasksPage() {
  const isTma = useIsTma();
  const pathname = usePathname();
  const isBoardPage = pathname === '/board';
  const [projects, setProjects] = useState<Project[]>([]);
  const [dbTasks, setDbTasks] = useState<Task[]>([]);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'tasks' | 'hypotheses'>('tasks');
  const [view, setView] = useState<'specialists' | 'projects' | 'board'>('specialists');
  // Set initial view: force board on /board page, or read ?view= param on /tasks
  useEffect(() => {
    if (isBoardPage) { setView('board'); return; }
    if (typeof window === 'undefined') return;
    const v = new URLSearchParams(window.location.search).get('view');
    if (v === 'board' || v === 'projects' || v === 'specialists') setView(v);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isBoardPage]);
  const [boards, setBoards] = useState<TaskBoard[]>([]);
  const [columns, setColumns] = useState<TaskBoardColumn[]>([]);
  const [selectedBoardId, setSelectedBoardId] = useState<string | null>(null);
  const [editingResultId, setEditingResultId] = useState<string | null>(null);
  const [editingResultValue, setEditingResultValue] = useState('');

  const [currentUserRole, setCurrentUserRole] = useState<UserRole | null>(null);
  const [currentUserName, setCurrentUserName] = useState<string | null>(null);
  const [allProfiles, setAllProfiles] = useState<ProfileOption[]>([]);

  const [showAddForm, setShowAddForm] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newProjectId, setNewProjectId] = useState('');
  const [newSpecialists, setNewSpecialists] = useState<string[]>([]);
  const [addingSaving, setAddingSaving] = useState(false);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [activeColumnId, setActiveColumnId] = useState<string | null>(null);
  const [showAddBoardForm, setShowAddBoardForm] = useState(false);
  const [newBoardName, setNewBoardName] = useState('');
  const [addingBoard, setAddingBoard] = useState(false);
  const [addingColumn, setAddingColumn] = useState(false);
  const [editingColumnId, setEditingColumnId] = useState<string | null>(null);
  const [editingColumnTitle, setEditingColumnTitle] = useState('');
  const [editingColumnStatus, setEditingColumnStatus] = useState<string>('');
  const [newTaskColumnId, setNewTaskColumnId] = useState<string | null>(null);
  const [showAddTaskModal, setShowAddTaskModal] = useState(false);
  const [newDescription, setNewDescription] = useState('');
  const [newImageUrl, setNewImageUrl] = useState('');
  const [editingDescriptionValue, setEditingDescriptionValue] = useState('');
  const [editingImageUrlValue, setEditingImageUrlValue] = useState('');
  const [taskImageUploading, setTaskImageUploading] = useState(false);
  const [newImageLoadError, setNewImageLoadError] = useState(false);
  const newTaskImageInputRef = useRef<HTMLInputElement>(null);
  const editTaskImageInputRef = useRef<HTMLInputElement>(null);
  const [taskModalTaskId, setTaskModalTaskId] = useState<string | null>(null);
  const [isModalInEditMode, setIsModalInEditMode] = useState(false);
  const [editingTitleValue, setEditingTitleValue] = useState('');
  const [editingProjectId, setEditingProjectId] = useState('');
  const [editingSpecialists, setEditingSpecialists] = useState<string[]>([]);
  const [assigneeFilterModal, setAssigneeFilterModal] = useState('');
  const [showDeleteTaskConfirm, setShowDeleteTaskConfirm] = useState(false);

  const userIsLead = checkIsLead(currentUserRole);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor)
  );

  useEffect(() => {
    void loadData();
  }, []);

  useEffect(() => {
    if (boards.length > 0 && selectedBoardId === null) {
      const defaultBoard = boards.find((b) => b.is_default) ?? boards[0];
      setSelectedBoardId(defaultBoard.id);
    }
  }, [boards, selectedBoardId]);

  useEffect(() => {
    if (!taskModalTaskId) {
      setIsModalInEditMode(false);
      setShowDeleteTaskConfirm(false);
    }
  }, [taskModalTaskId]);

  async function loadData() {
    try {
      setLoading(true);
      const { data: { session } } = await supabase.auth.getSession();
      if (session?.user?.id) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('role, full_name')
          .eq('id', session.user.id)
          .single();
        if (profile) {
          setCurrentUserRole(profile.role as UserRole);
          setCurrentUserName(profile.full_name as string);
        }
      }

      const [projRes, taskRes, boardsRes, columnsRes, profilesRes] = await Promise.all([
        supabase.from('projects').select('*'),
        supabase.from('tasks').select('*').order('created_at', { ascending: false }),
        supabase.from('task_boards').select('*').order('position', { ascending: true }),
        supabase.from('task_board_columns').select('*').order('position', { ascending: true }),
        supabase.from('profiles').select('id, full_name, email, role, avatar_url').order('full_name', { ascending: true }),
      ]);
      if (projRes.error) throw projRes.error;
      setProjects((projRes.data ?? []) as Project[]);
      setDbTasks((taskRes.data ?? []) as Task[]);
      const boardsData = (boardsRes.data ?? []) as TaskBoard[];
      setBoards(boardsData);
      setColumns((columnsRes.data ?? []) as TaskBoardColumn[]);
      setAllProfiles(
        ((profilesRes.data ?? []) as Parameters<typeof buildProfileOption>[0][])
          .map(buildProfileOption)
          .filter((p) => p.value)
      );
    } catch (error) {
      void logError('tasks.fetch.failed', error);
    } finally {
      setLoading(false);
    }
  }

  const updateTaskStatus = useCallback(async (taskId: string, newStatus: TaskStatus) => {
    setDbTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, status: newStatus } : t)));
    await supabase.from('tasks').update({ status: newStatus, updated_at: new Date().toISOString() }).eq('id', taskId);
  }, []);

  const updateTaskResult = useCallback(async (taskId: string, result: string) => {
    setDbTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, result } : t)));
    await supabase.from('tasks').update({ result, updated_at: new Date().toISOString() }).eq('id', taskId);
    setEditingResultId(null);
  }, []);

  const updateTaskDescriptionAndImage = useCallback(
    async (taskId: string, description: string, imageUrl: string) => {
      setDbTasks((prev) =>
        prev.map((t) =>
          t.id === taskId ? { ...t, description: description || null, image_url: imageUrl || null } : t
        )
      );
      await supabase
        .from('tasks')
        .update({
          description: description || null,
          image_url: imageUrl || null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', taskId);
    },
    []
  );

  const updateTaskTitle = useCallback(async (taskId: string, title: string) => {
    setDbTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, title } : t)));
    await supabase.from('tasks').update({ title, updated_at: new Date().toISOString() }).eq('id', taskId);
  }, []);

  const updateTaskSpecialist = useCallback(async (taskId: string, specialist: string) => {
    const value = specialist.trim() || null;
    setDbTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, specialist: value ?? undefined } : t)));
    await supabase.from('tasks').update({ specialist: value, updated_at: new Date().toISOString() }).eq('id', taskId);
  }, []);

  const updateTaskProject = useCallback(async (taskId: string, projectId: string | null) => {
    setDbTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, project_id: projectId } : t)));
    await supabase.from('tasks').update({ project_id: projectId, updated_at: new Date().toISOString() }).eq('id', taskId);
  }, []);

  const deleteTask = useCallback(async (taskId: string) => {
    setDbTasks((prev) => prev.filter((t) => t.id !== taskId));
    await supabase.from('tasks').delete().eq('id', taskId);
  }, []);

  const uploadTaskImage = useCallback(async (file: File): Promise<string> => {
    const { data: { session } } = await supabase.auth.getSession();
    const token = session?.access_token;
    if (!token) throw new Error('Необходимо войти в аккаунт');

    const contentType = file.type || 'image/png';
    const ext = file.name.split('.').pop()?.toLowerCase() || (contentType === 'image/jpeg' ? 'jpg' : 'png');

    const presignRes = await fetch('/api/tasks/image/presign', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ contentType, ext }),
    });
    if (!presignRes.ok) {
      const data = await presignRes.json().catch(() => null);
      throw new Error(typeof data?.error === 'string' ? data.error : 'Не удалось получить ссылку для загрузки');
    }
    const { uploadUrl, publicUrl } = (await presignRes.json()) as { uploadUrl: string; publicUrl: string };

    const uploadRes = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: file,
    });
    if (!uploadRes.ok) throw new Error(`Ошибка загрузки: ${uploadRes.status}`);
    return publicUrl;
  }, []);

  const updateTaskColumn = useCallback(
    async (taskId: string, columnId: string) => {
      const col = columns.find((c) => c.id === columnId);
      const colStatus = col?.status;
      const taskStatusValues: TaskStatus[] = ['pending', 'in_progress', 'done'];
      const newStatus = colStatus && taskStatusValues.includes(colStatus as TaskStatus) ? (colStatus as TaskStatus) : undefined;
      const payload: { column_id: string; board_id: string; status?: TaskStatus; updated_at: string } = {
        column_id: columnId,
        board_id: selectedBoardId!,
        updated_at: new Date().toISOString(),
      };
      if (newStatus) payload.status = newStatus;
      setDbTasks((prev) =>
        prev.map((t) =>
          t.id === taskId ? { ...t, column_id: columnId, board_id: selectedBoardId!, ...(newStatus && { status: newStatus }) } : t
        )
      );
      await supabase.from('tasks').update(payload).eq('id', taskId);
    },
    [columns, selectedBoardId]
  );

  const projectMap = useMemo(() => {
    const m = new Map<string, Project>();
    projects.forEach((p) => m.set(p.id, p));
    return m;
  }, [projects]);

  const promoteLegacyTask = useCallback(async (legacyTask: EnrichedTask, newStatus: TaskStatus) => {
    const projectId = legacyTask.project_id;
    if (!projectId) return;
    const p = projectMap.get(projectId);
    const { data, error } = await supabase
      .from('tasks')
      .insert({
        project_id: projectId,
        title: legacyTask.title,
        status: newStatus,
        specialist: p?.specialist || null,
      })
      .select()
      .single();
    if (!error && data) {
      setDbTasks((prev) => [data as Task, ...prev]);
    }
  }, [projectMap]);

  const shouldFilterByUser = !userIsLead && currentUserName;

  const regularTasks = useMemo<EnrichedTask[]>(() => {
    let tasks = dbTasks;
    if (shouldFilterByUser) {
      tasks = tasks.filter((t) => {
        const assignees = (t.specialist || '').split(',').map((s) => s.trim()).filter(Boolean);
        if (assignees.includes(currentUserName!)) return true;
        const p = t.project_id ? projectMap.get(t.project_id) : undefined;
        return p?.specialist === currentUserName;
      });
    }
    return tasks.map((t) => {
      const p = t.project_id != null ? projectMap.get(t.project_id) : undefined;
      return {
        ...t,
        projectName: p?.client || 'Без проекта',
        specialistName: t.specialist?.trim() || p?.specialist || 'Без специалиста',
      };
    });
  }, [dbTasks, projectMap, shouldFilterByUser, currentUserName]);

  const existingTaskTitles = useMemo(() => {
    const set = new Set<string>();
    dbTasks.forEach((t) => set.add(`${t.project_id}::${t.title}`));
    return set;
  }, [dbTasks]);

  const hypothesisTasks = useMemo<EnrichedTask[]>(() => {
    const enriched: EnrichedTask[] = [];
    const relevantProjects = shouldFilterByUser
      ? projects.filter((p) => p.specialist === currentUserName)
      : projects;

    relevantProjects.forEach((project) => {
      const legacy = splitLegacyTasks(project.hypotheses || project.weekly_tasks);
      legacy.forEach((title, idx) => {
        if (existingTaskTitles.has(`${project.id}::${title}`)) return;
        enriched.push({
          id: `legacy-${project.id}-${idx}`,
          project_id: project.id,
          title,
          status: 'pending' as TaskStatus,
          projectName: project.client || 'Без названия',
          specialistName: project.specialist || 'Без специалиста',
          isLegacy: true,
        });
      });
    });
    return enriched;
  }, [projects, shouldFilterByUser, currentUserName, existingTaskTitles]);

  const currentTasks = activeTab === 'tasks' ? regularTasks : hypothesisTasks;

  const tasksBySpecialist = useMemo(() => {
    const map = new Map<string, EnrichedTask[]>();
    currentTasks.forEach((t) => {
      const key = t.specialistName;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(t);
    });
    return Array.from(map.entries()).sort((a, b) => b[1].length - a[1].length);
  }, [currentTasks]);

  const tasksByProject = useMemo(() => {
    const map = new Map<string | null, { projectName: string; tasks: EnrichedTask[] }>();
    currentTasks.forEach((t) => {
      const key = t.project_id;
      if (!map.has(key)) map.set(key, { projectName: t.projectName, tasks: [] });
      map.get(key)!.tasks.push(t);
    });
    return Array.from(map.values()).filter((e) => e.tasks.length > 0);
  }, [currentTasks]);

  const specialistOptions = useMemo(() => {
    if (allProfiles.length > 0) return allProfiles;
    // fallback: derive names from projects when profiles not loaded yet
    const set = new Set<string>();
    projects.forEach((p) => { if (p.specialist) set.add(p.specialist); });
    return Array.from(set).sort().map((name) => buildProfileOption({ id: name, full_name: name, email: '', role: null, avatar_url: null }));
  }, [allProfiles, projects]);

  const selectedBoardColumns = useMemo(() => {
    if (!selectedBoardId) return [];
    return columns.filter((c) => c.board_id === selectedBoardId).sort((a, b) => a.position - b.position);
  }, [columns, selectedBoardId]);

  const tasksByColumnForBoard = useMemo(() => {
    if (!selectedBoardId || activeTab !== 'tasks') return new Map<string, EnrichedTask[]>();
    const onlyRegular = regularTasks.filter((t) => !t.isLegacy);
    const isDefaultBoard = selectedBoardId === DEFAULT_BOARD_ID;
    const inBoard = onlyRegular.filter(
      (t) => t.board_id === selectedBoardId || (isDefaultBoard && t.board_id == null)
    );
    const map = new Map<string, EnrichedTask[]>();
    selectedBoardColumns.forEach((col) => {
      const inColumn = inBoard.filter((t) => {
        if (t.column_id != null) return t.column_id === col.id;
        if (isDefaultBoard && col.status != null) return t.status === col.status;
        return false;
      });
      map.set(col.id, inColumn);
    });
    return map;
  }, [selectedBoardId, activeTab, regularTasks, selectedBoardColumns]);

  const activeTask = useMemo(
    () => (activeTaskId ? regularTasks.find((t) => t.id === activeTaskId) : null),
    [activeTaskId, regularTasks]
  );

  const modalTask = useMemo(
    () => (taskModalTaskId ? regularTasks.find((t) => t.id === taskModalTaskId) ?? null : null),
    [taskModalTaskId, regularTasks]
  );

  const activeColumn = useMemo(
    () =>
      activeColumnId && activeColumnId.startsWith(COLUMN_DRAG_PREFIX)
        ? selectedBoardColumns.find((c) => COLUMN_DRAG_PREFIX + c.id === activeColumnId) ?? null
        : null,
    [activeColumnId, selectedBoardColumns]
  );

  const handleBoardDragStart = useCallback((event: DragStartEvent) => {
    const id = String(event.active.id);
    if (id.startsWith(COLUMN_DRAG_PREFIX)) {
      setActiveColumnId(id);
      setActiveTaskId(null);
    } else {
      setActiveTaskId(id);
      setActiveColumnId(null);
    }
  }, []);

  const reorderColumnsInDb = useCallback(
    async (newOrder: TaskBoardColumn[]) => {
      try {
        await Promise.all(
          newOrder.map((col, idx) =>
            supabase.from('task_board_columns').update({ position: idx }).eq('id', col.id)
          )
        );
        setColumns((prev) =>
          prev.map((c) => {
            const idx = newOrder.findIndex((o) => o.id === c.id);
            return idx >= 0 ? { ...c, position: idx } : c;
          })
        );
      } catch (error) {
        void logError('tasks.column.reorder.failed', error);
      }
    },
    []
  );

  const handleBoardDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      const activeId = String(active.id);
      setActiveTaskId(null);
      setActiveColumnId(null);
      if (!over || !selectedBoardId) return;

      if (activeId.startsWith(COLUMN_DRAG_PREFIX)) {
        const draggedColId = activeId.slice(COLUMN_DRAG_PREFIX.length);
        const overId = over.id as string;
        const columnIds = selectedBoardColumns.map((c) => c.id);
        if (!columnIds.includes(overId) || overId === draggedColId) return;
        const fromIdx = selectedBoardColumns.findIndex((c) => c.id === draggedColId);
        const toIdx = selectedBoardColumns.findIndex((c) => c.id === overId);
        if (fromIdx < 0 || toIdx < 0) return;
        const next = [...selectedBoardColumns];
        const [removed] = next.splice(fromIdx, 1);
        next.splice(toIdx, 0, removed);
        const withPositions = next.map((c, i) => ({ ...c, position: i }));
        void reorderColumnsInDb(withPositions);
        return;
      }

      const columnIds = selectedBoardColumns.map((c) => c.id);
      if (columnIds.includes(over.id as string)) {
        void updateTaskColumn(activeId, over.id as string);
      }
    },
    [selectedBoardId, selectedBoardColumns, updateTaskColumn, reorderColumnsInDb]
  );

  function getNewTaskSpecialist(): string {
    return newSpecialists.join(', ').trim();
  }

  async function handleAddTask() {
    const specialistValue = getNewTaskSpecialist();
    if (!newTitle.trim() || !specialistValue) return;
    setAddingSaving(true);
    try {
      const isBoardTask = view === 'board' && selectedBoardId && selectedBoardColumns.length > 0;
      const payload: Record<string, string | null> = {
        title: newTitle.trim(),
        specialist: specialistValue,
        project_id: isBoardTask ? null : (newProjectId || null),
        status: 'pending',
        description: newDescription.trim() || null,
        image_url: newImageUrl.trim() || null,
      };
      if (isBoardTask) {
        payload.board_id = selectedBoardId!;
        const targetColId = newTaskColumnId ?? selectedBoardColumns[0].id;
        const targetCol = selectedBoardColumns.find((c) => c.id === targetColId);
        payload.column_id = targetColId;
        if (targetCol?.status) payload.status = targetCol.status;
      }
      const { data, error } = await supabase.from('tasks').insert(payload).select().single();
      if (error) throw error;
      setDbTasks((prev) => [data as Task, ...prev]);
      setNewTitle('');
      setNewProjectId('');
      setNewSpecialists([]);
      setNewDescription('');
      setNewImageUrl('');
      setShowAddForm(false);
      setNewTaskColumnId(null);
    } catch (error) {
      void logError('tasks.add.failed', error);
    } finally {
      setAddingSaving(false);
    }
  }

  async function handleAddBoard() {
    if (!newBoardName.trim()) return;
    setAddingBoard(true);
    try {
      const maxPos = boards.length > 0 ? Math.max(...boards.map((b) => b.position), 0) + 1 : 0;
      const { data, error } = await supabase
        .from('task_boards')
        .insert({ name: newBoardName.trim(), is_default: false, position: maxPos })
        .select()
        .single();
      if (error) throw error;
      setBoards((prev) => [...prev, data as TaskBoard]);
      setNewBoardName('');
      setShowAddBoardForm(false);
      setSelectedBoardId(data.id);
    } catch (error) {
      void logError('tasks.board.add.failed', error);
    } finally {
      setAddingBoard(false);
    }
  }

  async function handleCreateColumn() {
    if (!selectedBoardId) return;
    setAddingColumn(true);
    try {
      const boardCols = columns.filter((c) => c.board_id === selectedBoardId);
      const maxPos = boardCols.length > 0 ? Math.max(...boardCols.map((c) => c.position), 0) + 1 : 0;
      const payload = {
        board_id: selectedBoardId,
        title: 'Новая колонка',
        position: maxPos,
      };
      const { data, error } = await supabase.from('task_board_columns').insert(payload).select().single();
      if (error) throw error;
      const newCol = data as TaskBoardColumn;
      setColumns((prev) => [...prev, newCol]);
      setEditingColumnId(newCol.id);
      setEditingColumnTitle(newCol.title);
      setEditingColumnStatus((newCol.status as string) || '');
    } catch (error) {
      void logError('tasks.column.add.failed', error);
    } finally {
      setAddingColumn(false);
    }
  }

  async function handleUpdateColumn(columnId: string, title: string, status: string) {
    setAddingColumn(true);
    try {
      const payload: { title?: string; status?: string | null } = {};
      if (title.trim()) payload.title = title.trim();
      const validStatuses = ['pending', 'in_progress', 'done', 'backlog', 'deferred'];
      if (status && validStatuses.includes(status)) payload.status = status;
      else payload.status = null;
      const { error } = await supabase.from('task_board_columns').update(payload).eq('id', columnId);
      if (error) throw error;
      setColumns((prev) =>
        prev.map((c) =>
          c.id === columnId
            ? { ...c, title: title.trim() || c.title, status: status && validStatuses.includes(status) ? status : null }
            : c
        )
      );
      setEditingColumnId(null);
    } catch (error) {
      void logError('tasks.column.update.failed', error);
    } finally {
      setAddingColumn(false);
    }
  }

  const sortedBoards = useMemo(
    () => [...boards].sort((a, b) => a.position - b.position),
    [boards]
  );

  function renderTaskCard(task: EnrichedTask) {
    const statusCfg = TASK_STATUS_CONFIG[task.status as TaskStatus] ?? TASK_STATUS_CONFIG.pending;
    const isEditingResult = editingResultId === task.id;
    const statusOptions: TaskStatus[] = ['pending', 'in_progress', 'done'];
    const selectValue = statusOptions.includes(task.status as TaskStatus) ? task.status : 'pending';

    return (
      <div key={task.id} className={`rounded-lg border p-3 transition-colors ${task.status === 'done' ? 'bg-gray-50 border-gray-200' : 'bg-white border-gray-200'}`}>
        <div className="flex items-start justify-between gap-2">
          <div className="flex-1 min-w-0">
            <p className="text-xs text-gray-500">{task.projectName}</p>
            <p className={`break-words text-sm font-medium mt-0.5 ${task.status === 'done' ? 'text-gray-400 line-through' : 'text-gray-900'}`}>
              {task.title}
            </p>
          </div>
          <div className="flex items-center gap-1.5 flex-shrink-0">
            <select
              value={selectValue}
              onChange={(e) => {
                const newStatus = e.target.value as TaskStatus;
                if (task.isLegacy) {
                  void promoteLegacyTask(task, newStatus);
                } else {
                  void updateTaskStatus(task.id, newStatus);
                }
              }}
              className={`appearance-none cursor-pointer rounded-full border px-2.5 py-0.5 text-[10px] font-semibold outline-none ${statusCfg.className}`}
            >
              {statusOptions.map((s) => (
                <option key={s} value={s}>{TASK_STATUS_CONFIG[s].label}</option>
              ))}
            </select>
          </div>
        </div>

        {!task.isLegacy && ((task.description != null && task.description !== '') || (task.image_url != null && task.image_url !== '')) && (
          <div className="mt-2 pt-2 border-t border-gray-100">
            {task.description && <p className="text-xs text-gray-600 line-clamp-2">{task.description}</p>}
            {task.image_url && <img src={task.image_url} alt="" className="mt-1 h-16 w-full rounded object-cover" />}
          </div>
        )}
        {!task.isLegacy && (
          <div className="mt-2 pt-2 border-t border-gray-100">
            {isEditingResult ? (
              <div className="flex gap-1.5">
                <input
                  type="text"
                  autoFocus
                  value={editingResultValue}
                  onChange={(e) => setEditingResultValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void updateTaskResult(task.id, editingResultValue);
                    if (e.key === 'Escape') setEditingResultId(null);
                  }}
                  className="flex-1 text-xs border border-gray-200 rounded-lg px-2 py-1 outline-none focus:border-blue-400"
                  placeholder="Результат задачи..."
                />
                <button
                  type="button"
                  onClick={() => void updateTaskResult(task.id, editingResultValue)}
                  className="text-xs bg-blue-600 text-white px-2 py-1 rounded-lg hover:bg-blue-700"
                >
                  ✓
                </button>
              </div>
            ) : (
              <div
                className="cursor-pointer hover:bg-gray-50 rounded px-1 py-0.5 -mx-1 transition-colors"
                onClick={() => {
                  setEditingResultId(task.id);
                  setEditingResultValue(task.result || '');
                }}
              >
                {task.result ? (
                  <p className="text-xs text-gray-700"><span className="font-medium text-gray-500">Результат:</span> {task.result}</p>
                ) : (
                  <p className="text-xs text-gray-400">+ Добавить результат</p>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="text-gray-500">Загрузка...</div>
      </div>
    );
  }

  return (
    <div className={isTma ? 'space-y-4' : 'space-y-6'}>
      <div className={isTma ? 'flex flex-col gap-3' : 'flex flex-wrap items-center justify-between gap-4'}>
        <div>
          <p className="text-sm text-gray-400">{isBoardPage ? 'Главная / Доска' : 'Главная / задачи'}</p>
          <h1 className={`${isTma ? 'text-xl' : 'text-2xl'} font-semibold text-gray-900`}>
            {isBoardPage ? 'Доска' : 'Задачи'}
          </h1>
          {!isBoardPage && (
            <p className="mt-1 text-sm text-gray-500">
              {shouldFilterByUser ? 'Ваши задачи.' : 'Задачи специалистов и проектов в одном месте.'}
            </p>
          )}
        </div>
        {userIsLead && view !== 'board' && (
          <button
            type="button"
            onClick={() => setShowAddForm((v) => !v)}
            className="flex items-center gap-1.5 rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 transition-colors"
          >
            + Добавить задачу
          </button>
        )}
      </div>

      {showAddForm && userIsLead && (
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-lg shadow-slate-200/30 space-y-4">
          <h3 className="text-base font-semibold text-slate-800">Новая задача</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div>
              <span className="mb-1.5 block text-xs font-medium text-slate-500">Проект</span>
              <select
                value={newProjectId}
                onChange={(e) => setNewProjectId(e.target.value)}
                className="w-full rounded-xl border border-slate-200 bg-slate-50/80 py-2.5 pl-3 pr-9 text-sm text-slate-800 shadow-sm outline-none transition focus:border-slate-400 focus:bg-white focus:ring-2 focus:ring-slate-400/20"
              >
                <option value="">Без проекта</option>
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>{p.client || p.name || 'Без названия'}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-slate-500">Задача *</label>
              <input
                type="text"
                value={newTitle}
                onChange={(e) => setNewTitle(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void handleAddTask();
                }}
                placeholder="Название задачи"
                className="w-full rounded-xl border border-slate-200 bg-slate-50/80 px-3 py-2.5 text-sm text-slate-800 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-slate-400 focus:bg-white focus:ring-2 focus:ring-slate-400/20"
              />
            </div>
            <div>
              <span className="mb-1.5 block text-xs font-medium text-slate-500">Исполнители</span>
              <div className="max-h-52 overflow-y-auto rounded-xl border border-slate-200/80 bg-slate-50/60 py-1 shadow-sm">
                {specialistOptions.map((p) => (
                  <label
                    key={p.id}
                    className={`flex cursor-pointer items-center gap-2.5 px-3 py-2 transition-colors ${newSpecialists.includes(p.value) ? 'bg-blue-50/60' : 'hover:bg-slate-100/50'}`}
                  >
                    <input
                      type="checkbox"
                            checked={newSpecialists.includes(p.value)}
                            onChange={(e) => {
                              setNewSpecialists((prev) =>
                                e.target.checked ? [...prev, p.value] : prev.filter((x) => x !== p.value)
                              );
                            }}
                            className="h-4 w-4 shrink-0 rounded-md border-slate-300 text-blue-600 shadow-sm focus:ring-2 focus:ring-blue-400 focus:ring-offset-0"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-xs font-semibold text-slate-800">@{p.nickname}</span>
                            {p.fullName && p.fullName !== p.nickname && (
                              <span className="block truncate text-[10px] text-slate-400">{p.fullName}</span>
                            )}
                          </span>
                    {p.role && (
                      <span className="shrink-0 rounded-full bg-slate-100 px-1.5 py-0.5 text-[9px] font-medium text-slate-500">
                        {ROLE_LABELS[p.role] ?? p.role}
                      </span>
                    )}
                  </label>
                ))}
                {specialistOptions.length === 0 && (
                  <p className="px-3 py-2 text-xs text-slate-500">Нет специалистов</p>
                )}
              </div>
            </div>
          </div>
          <div className="space-y-3">
            <div>
              <span className="mb-1.5 block text-xs font-medium text-slate-500">Описание</span>
              <textarea
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
                onInput={(e) => { const t = e.currentTarget; t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px'; }}
                placeholder="Текст описания задачи..."
                rows={2}
                className="w-full resize-none rounded-xl border border-slate-200 bg-slate-50/80 px-3 py-2 text-sm text-slate-800 shadow-sm outline-none transition placeholder:text-slate-400 focus:border-slate-400 focus:bg-white focus:ring-2 focus:ring-slate-400/20"
              />
            </div>
            <div>
              <span className="mb-1.5 block text-xs font-medium text-slate-500">Картинка</span>
              <div
                className="rounded-xl border border-slate-200 bg-slate-50/50 p-3 focus-within:border-slate-400 focus-within:ring-2 focus-within:ring-slate-400/20"
              onPaste={async (e) => {
                const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith('image/'));
                const file = item?.getAsFile();
                if (!file) return;
                e.preventDefault();
                setTaskImageUploading(true);
                try {
                  const url = await uploadTaskImage(file);
                  setNewImageUrl(url);
                } catch (err) {
                  void logError('tasks.image.upload.failed', err);
                } finally {
                  setTaskImageUploading(false);
                }
              }}
            >
              <input
                ref={newTaskImageInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  e.target.value = '';
                  setTaskImageUploading(true);
                  try {
                    const url = await uploadTaskImage(file);
                    setNewImageUrl(url);
                  } catch (err) {
                    void logError('tasks.image.upload.failed', err);
                  } finally {
                    setTaskImageUploading(false);
                  }
                }}
              />
              {newImageUrl ? (
                <>
                  <div className="min-h-24 w-full overflow-hidden rounded-lg bg-gray-100">
                    <img
                      src={newImageUrl}
                      alt=""
                      referrerPolicy="no-referrer"
                      className="max-h-40 w-full object-contain"
                      onLoad={() => setNewImageLoadError(false)}
                      onError={() => setNewImageLoadError(true)}
                    />
                    {newImageLoadError && (
                      <p className="p-2 text-center text-xs text-amber-600">Не удалось загрузить изображение</p>
                    )}
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={taskImageUploading}
                      onClick={() => newTaskImageInputRef.current?.click()}
                      className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 shadow-sm hover:bg-gray-50 disabled:opacity-50"
                    >
                      {taskImageUploading ? 'Загрузка...' : 'Заменить'}
                    </button>
                    <button
                      type="button"
                      onClick={() => { setNewImageUrl(''); setNewImageLoadError(false); }}
                      className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-500 hover:bg-gray-50"
                    >
                      Удалить
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="flex flex-wrap items-center gap-2">
                    <button
                      type="button"
                      disabled={taskImageUploading}
                      onClick={() => newTaskImageInputRef.current?.click()}
                      className="rounded-lg border border-gray-300 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 shadow-sm hover:bg-gray-50 disabled:opacity-50"
                    >
                      {taskImageUploading ? 'Загрузка...' : 'Выбрать с компьютера'}
                    </button>
                    <span className="text-xs text-gray-500">или Ctrl+V</span>
                  </div>
                  <input
                    type="url"
                    value={newImageUrl}
                    onChange={(e) => { setNewImageUrl(e.target.value); setNewImageLoadError(false); }}
                    placeholder="или вставьте ссылку на картинку"
                    className="mt-2 w-full text-sm border border-gray-200 rounded px-2 py-1.5 outline-none focus:border-blue-400"
                  />
                </>
              )}
            </div>
            </div>
          </div>
          <div className="flex items-center gap-2 pt-1">
            <button
              type="button"
              disabled={addingSaving || !newTitle.trim() || newSpecialists.length === 0}
              onClick={() => void handleAddTask()}
              className="rounded-xl bg-slate-800 px-4 py-2.5 text-sm font-medium text-white shadow-md transition hover:bg-slate-700 disabled:opacity-50"
            >
              {addingSaving ? 'Сохранение...' : 'Создать'}
            </button>
            <button
              type="button"
              onClick={() => { setShowAddForm(false); setNewTaskColumnId(null); setNewTitle(''); setNewProjectId(''); setNewSpecialists([]); setNewDescription(''); setNewImageUrl(''); }}
              className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-600 shadow-sm transition hover:bg-slate-50"
            >
              Отмена
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {view !== 'board' && (
          <div className={isTma ? 'flex items-center rounded-full bg-gray-100 p-1' : 'flex items-center rounded-full bg-gray-100 p-1'}>
            <button
              type="button"
              onClick={() => setActiveTab('tasks')}
              className={`${isTma ? 'flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium transition' : 'flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition'} ${
                activeTab === 'tasks' ? 'bg-lime-300 text-gray-900' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              Задачи
              <span className={`text-xs ${activeTab === 'tasks' ? 'text-gray-600' : 'text-gray-400'}`}>
                {regularTasks.length}
              </span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('hypotheses')}
              className={`${isTma ? 'flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium transition' : 'flex items-center gap-2 rounded-full px-4 py-2 text-sm font-medium transition'} ${
                activeTab === 'hypotheses' ? 'bg-lime-300 text-gray-900' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              Задачи по гипотезам
              <span className={`text-xs ${activeTab === 'hypotheses' ? 'text-gray-600' : 'text-gray-400'}`}>
                {hypothesisTasks.length}
              </span>
            </button>
          </div>
        )}
        {!isBoardPage && (
          <div className="flex items-center rounded-full bg-gray-100 p-1">
            <button
              type="button"
              onClick={() => setView('specialists')}
              className={`flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium transition ${
                view === 'specialists' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              по специалистам
            </button>
            <button
              type="button"
              onClick={() => setView('projects')}
              className={`flex items-center gap-2 rounded-full px-3 py-1.5 text-xs font-medium transition ${
                view === 'projects' ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
              }`}
            >
              по проектам
            </button>
          </div>
        )}
      </div>

      {view === 'specialists' && (
        <div className={isTma ? 'grid grid-cols-1 gap-4' : 'grid grid-cols-1 gap-6 lg:grid-cols-3'}>
          {tasksBySpecialist.map(([specialist, list]) => (
            <div key={specialist} className={`rounded-xl border border-gray-200 bg-white shadow-sm ${isTma ? 'p-4' : 'p-5'}`}>
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-lg font-semibold text-gray-900">{specialist}</h3>
                  <p className="text-xs text-gray-500">{list.length} задач</p>
                </div>
              </div>
              <div className="mt-4 space-y-3">
                {list.map(renderTaskCard)}
                {list.length === 0 && (
                  <div className="rounded-lg border border-dashed border-gray-200 p-3 text-center text-sm text-gray-400">
                    Нет задач
                  </div>
                )}
              </div>
            </div>
          ))}
          {tasksBySpecialist.length === 0 && (
            <div className={`rounded-xl border border-dashed border-gray-200 text-center text-sm text-gray-500 col-span-full ${isTma ? 'p-5' : 'p-6'}`}>
              Задачи пока не добавлены.
            </div>
          )}
        </div>
      )}

      {view === 'projects' && (
        <div className={isTma ? 'grid grid-cols-1 gap-4' : 'grid grid-cols-1 gap-6 lg:grid-cols-3'}>
          {tasksByProject.map(({ projectName, tasks: list }) => (
            <div key={projectName} className={`rounded-xl border border-gray-200 bg-white shadow-sm ${isTma ? 'p-4' : 'p-5'}`}>
              <div>
                <h3 className="text-lg font-semibold text-gray-900">{projectName}</h3>
                <p className="text-xs text-gray-500">{list.length} задач</p>
              </div>
              <div className="mt-4 space-y-3">
                {list.map(renderTaskCard)}
              </div>
            </div>
          ))}
          {tasksByProject.length === 0 && (
            <div className={`rounded-xl border border-dashed border-gray-200 text-center text-sm text-gray-500 col-span-full ${isTma ? 'p-5' : 'p-6'}`}>
              Нет проектов для отображения.
            </div>
          )}
        </div>
      )}

      {view === 'board' && activeTab === 'tasks' && (
        <DndContext sensors={sensors} onDragStart={handleBoardDragStart} onDragEnd={handleBoardDragEnd}>
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={selectedBoardId ?? ''}
                onChange={(e) => setSelectedBoardId(e.target.value || null)}
                className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm outline-none focus:border-blue-400"
              >
                <option value="">{boards.length === 0 ? 'Нет досок' : 'Выберите доску'}</option>
                {sortedBoards.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name} {b.is_default ? '(по умолчанию)' : ''}
                  </option>
                ))}
              </select>
              {userIsLead && (
                <>
                  <button
                    type="button"
                    onClick={() => setShowAddBoardForm(true)}
                    className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50"
                  >
                    + Создать доску
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleCreateColumn()}
                    disabled={!selectedBoardId || addingColumn}
                    className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
                  >
                    {addingColumn ? 'Добавление...' : '+ Добавить колонку'}
                  </button>
                </>
              )}
            </div>
            {showAddBoardForm && userIsLead && (
              <div
                className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-4 backdrop-blur-sm"
                onClick={() => { setShowAddBoardForm(false); setNewBoardName(''); }}
              >
                <div
                  className="w-full max-w-md rounded-xl border border-gray-200 bg-white p-5 shadow-xl"
                  onClick={(e) => e.stopPropagation()}
                >
                  <h3 className="text-lg font-semibold text-gray-900">Создать доску</h3>
                  <input
                    type="text"
                    value={newBoardName}
                    onChange={(e) => setNewBoardName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void handleAddBoard();
                      if (e.key === 'Escape') { setShowAddBoardForm(false); setNewBoardName(''); }
                    }}
                    placeholder="Название доски"
                    className="mt-3 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-blue-400 focus:ring-2 focus:ring-blue-400/20"
                    autoFocus
                  />
                  <div className="mt-4 flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => { setShowAddBoardForm(false); setNewBoardName(''); }}
                      className="rounded-lg border border-gray-200 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
                    >
                      Отмена
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleAddBoard()}
                      disabled={addingBoard || !newBoardName.trim()}
                      className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                    >
                      {addingBoard ? 'Создание...' : 'Создать'}
                    </button>
                  </div>
                </div>
              </div>
            )}
            {selectedBoardColumns.length === 0 ? (
              <div className="rounded-xl border border-dashed border-gray-300 bg-gray-50/50 py-12 text-center">
                {boards.length === 0 ? (
                  <p className="text-sm text-gray-600">
                    Нет досок. Примените миграции БД (файл <code className="rounded bg-gray-200 px-1 text-xs">supabase/migrations/20260228_0001_task_boards_and_columns.sql</code>), чтобы появилась доска по умолчанию с колонками.
                  </p>
                ) : (
                  <p className="text-sm text-gray-600">
                    На выбранной доске нет колонок. Нажмите «+ Добавить колонку», чтобы создать колонки (например: Ожидает, В работе, Завершено).
                  </p>
                )}
              </div>
            ) : (
              <div className="flex gap-4 overflow-x-auto pb-2">
                {selectedBoardColumns.map((col) => (
                  <DroppableColumn
                    key={col.id}
                    columnId={col.id}
                    baseClassName="flex w-72 flex-shrink-0 flex-col rounded-xl border border-gray-200 bg-gray-50/80 p-3 transition-colors"
                  >
                    <div className="mb-2 flex items-center justify-between gap-1">
                      {userIsLead && editingColumnId === col.id ? (
                        <div className="min-w-0 flex-1 space-y-2" onClick={(e) => e.stopPropagation()}>
                          <input
                            type="text"
                            value={editingColumnTitle}
                            onChange={(e) => setEditingColumnTitle(e.target.value)}
                            placeholder="Название колонки"
                            className="w-full rounded border border-gray-200 px-2 py-1 text-sm outline-none focus:border-blue-400"
                          />
                          <select
                            value={editingColumnStatus}
                            onChange={(e) => setEditingColumnStatus(e.target.value)}
                            className="w-full rounded border border-gray-200 px-2 py-1 text-sm outline-none focus:border-blue-400"
                          >
                            <option value="">Без статуса</option>
                            <option value="backlog">Бэк лог</option>
                            <option value="pending">Ожидает</option>
                            <option value="in_progress">В работе</option>
                            <option value="done">Завершено</option>
                            <option value="deferred">Отложено</option>
                          </select>
                          <div className="flex gap-1">
                            <button
                              type="button"
                              onClick={() => void handleUpdateColumn(col.id, editingColumnTitle, editingColumnStatus)}
                              disabled={addingColumn}
                              className="rounded bg-blue-600 px-2 py-1 text-xs text-white hover:bg-blue-700 disabled:opacity-50"
                            >
                              {addingColumn ? '…' : 'Сохранить'}
                            </button>
                            <button
                              type="button"
                              onClick={() => setEditingColumnId(null)}
                              className="rounded border border-gray-200 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50"
                            >
                              Отмена
                            </button>
                          </div>
                        </div>
                      ) : userIsLead ? (
                        <DraggableColumnHeader column={col}>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setEditingColumnId(col.id);
                              setEditingColumnTitle(col.title);
                              setEditingColumnStatus((col.status as string) || '');
                            }}
                            className="min-w-0 flex-1 text-left text-sm font-semibold text-gray-900 truncate hover:text-blue-600"
                            title="Изменить колонку"
                          >
                            {col.title}
                          </button>
                          <button
                            type="button"
                            onClick={(e) => {
                              e.stopPropagation();
                              setNewTaskColumnId(col.id);
                              setNewTitle('');
                              setNewProjectId('');
                              setNewSpecialists([]);
                              setNewDescription('');
                              setNewImageUrl('');
                              setAssigneeFilterModal('');
                              setShowAddTaskModal(true);
                            }}
                            className="flex-shrink-0 rounded bg-blue-600 px-2 py-1 text-xs font-medium text-white hover:bg-blue-700"
                          >
                            + Задача
                          </button>
                        </DraggableColumnHeader>
                      ) : (
                        <h3 className="min-w-0 flex-1 text-sm font-semibold text-gray-900 truncate">{col.title}</h3>
                      )}
                    </div>
                    <div className="flex flex-1 flex-col gap-2 overflow-y-auto">
                      {(tasksByColumnForBoard.get(col.id) ?? []).map((task) => {
                        const columnHasStatus = col.status && ['pending', 'in_progress', 'done', 'deferred'].includes(col.status);
                        // Strikethrough only when task is physically in a "done" column
                        const displayDone = col.status === 'done';
                        const barColor =
                          col.status === 'backlog'
                            ? 'bg-red-500'
                            : col.status === 'deferred'
                              ? 'bg-purple-400'
                              : !columnHasStatus
                                ? 'bg-emerald-500'
                                : task.status === 'done'
                                  ? 'bg-gray-300'
                                  : task.status === 'in_progress'
                                    ? 'bg-blue-400'
                                    : 'bg-amber-400/80';
                        return (
                          <DraggableTaskCard key={task.id} task={task}>
                            <div
                              role="button"
                              tabIndex={0}
                              onClick={(e) => {
                                e.stopPropagation();
                                setTaskModalTaskId(task.id);
                              }}
                              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setTaskModalTaskId(task.id); } }}
                              className={`group relative overflow-hidden rounded-xl border transition-all ${
                                displayDone
                                  ? 'border-gray-200 bg-gray-50/80'
                                  : 'border-gray-200/90 bg-white shadow-sm shadow-gray-200/40 hover:shadow-md hover:shadow-gray-200/50'
                              } cursor-grab active:cursor-grabbing cursor-pointer`}
                            >
                              <div className={`absolute left-0 top-0 h-full w-1 ${barColor}`} />
                              <div className="min-w-0 p-3 pl-4">
                                <p className="text-xs text-gray-500">
                                  Исполнитель: <span className="font-medium text-gray-600">{task.specialistName}</span>
                                </p>
                                <p className={`mt-1 break-words text-sm font-semibold leading-snug ${displayDone ? 'text-gray-400 line-through' : 'text-gray-900'}`}>
                                  {task.title}
                                </p>
                              </div>
                            </div>
                          </DraggableTaskCard>
                        );
                      })}
                    </div>
                  </DroppableColumn>
                ))}
              </div>
            )}
          </div>
          <DragOverlay>
            {activeColumn ? (
              <div className="rounded-xl border-2 border-blue-400 bg-white px-3 py-2 shadow-lg">
                <span className="text-sm font-semibold text-gray-900">{activeColumn.title}</span>
              </div>
            ) : activeTask ? (
              <div className="relative w-64 overflow-hidden rounded-xl border-2 border-blue-300 bg-white shadow-xl shadow-gray-300/40">
                <div className={`absolute left-0 top-0 h-full w-1 ${activeTask.status === 'in_progress' ? 'bg-blue-400' : 'bg-amber-400/80'}`} />
                <div className="min-w-0 p-3 pl-4">
                  <p className="text-xs text-gray-500">Исполнитель: {activeTask.specialistName}</p>
                  <p className="mt-1 break-words text-sm font-semibold leading-snug text-gray-900">
                    {activeTask.title}
                  </p>
                  {activeTask.description && <p className="mt-1 line-clamp-2 text-xs text-gray-600">{activeTask.description}</p>}
                  {activeTask.image_url && <img src={activeTask.image_url} alt="" className="mt-1.5 max-h-20 w-full rounded-lg object-cover" />}
                  {activeTask.result && (
                    <p className="mt-2 text-xs text-gray-600">
                      <span className="font-medium text-gray-500">Результат:</span> {activeTask.result}
                    </p>
                  )}
                </div>
              </div>
            ) : null}
          </DragOverlay>
        </DndContext>
      )}

      {showAddTaskModal && view === 'board' && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/25 p-4 backdrop-blur-sm"
          onClick={() => {
            setShowAddTaskModal(false);
            setNewTaskColumnId(null);
            setNewTitle('');
            setNewProjectId('');
            setNewSpecialists([]);
            setNewDescription('');
            setNewImageUrl('');
            setAssigneeFilterModal('');
          }}
        >
          <div
            className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-slate-200 bg-white shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-slate-200 bg-white px-3 py-2">
              <div>
                <h3 className="text-sm font-semibold text-slate-900">Новая задача</h3>
                {newTaskColumnId && (
                  <p className="mt-0.5 text-[11px] text-slate-500">
                    Колонка: {selectedBoardColumns.find((c) => c.id === newTaskColumnId)?.title ?? ''}
                  </p>
                )}
              </div>
              <button
                type="button"
                onClick={() => {
                  setShowAddTaskModal(false);
                  setNewTaskColumnId(null);
                  setNewTitle('');
                  setNewProjectId('');
                  setNewSpecialists([]);
                  setNewDescription('');
                  setNewImageUrl('');
                  setAssigneeFilterModal('');
                }}
                className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-700 text-sm"
                aria-label="Закрыть"
              >
                ×
              </button>
            </div>
            <div className="p-3 space-y-3 text-[13px]">
              <div>
                <span className="mb-1 block text-[11px] font-medium text-slate-500">Название *</span>
                <input
                  type="text"
                  autoFocus
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void handleAddTask();
                    if (e.key === 'Escape') {
                      setShowAddTaskModal(false);
                      setNewTaskColumnId(null);
                      setNewTitle('');
                      setNewSpecialists([]);
                    }
                  }}
                  placeholder="Название задачи..."
                  className="w-full rounded-lg border border-slate-200 bg-slate-50/80 px-2.5 py-2 text-xs text-slate-800 shadow-sm placeholder:text-slate-400 outline-none transition focus:border-slate-400 focus:bg-white focus:ring-2 focus:ring-slate-400/20"
                />
              </div>
              <div>
                <span className="mb-1 block text-[11px] font-medium text-slate-500">Исполнители</span>
                <input
                  type="text"
                  value={assigneeFilterModal}
                  onChange={(e) => setAssigneeFilterModal(e.target.value)}
                  placeholder="Поиск по никнейму или роли..."
                  className="mb-1.5 w-full rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 text-xs text-slate-800 placeholder:text-slate-400 outline-none focus:border-blue-400 focus:ring-1 focus:ring-blue-200"
                />
                <div className="max-h-52 overflow-y-auto overflow-x-hidden rounded-lg border border-slate-200/80 bg-white py-1 shadow-sm">
                  {(() => {
                    const q = assigneeFilterModal.trim().toLowerCase();
                    const filtered = q
                      ? specialistOptions.filter((p) =>
                          p.nickname.toLowerCase().includes(q) ||
                          p.fullName.toLowerCase().includes(q) ||
                          (p.role && (ROLE_LABELS[p.role] ?? p.role).toLowerCase().includes(q))
                        )
                      : specialistOptions;
                    return (
                      <>
                        {filtered.map((p) => (
                          <label
                            key={p.id}
                            className={`flex cursor-pointer items-center gap-2 px-2.5 py-1.5 transition-colors ${newSpecialists.includes(p.value) ? 'bg-blue-50/70' : 'hover:bg-slate-50'}`}
                          >
                            <input
                              type="checkbox"
                            checked={newSpecialists.includes(p.value)}
                            onChange={(e) => {
                              setNewSpecialists((prev) =>
                                e.target.checked ? [...prev, p.value] : prev.filter((x) => x !== p.value)
                              );
                            }}
                            className="h-3.5 w-3.5 shrink-0 rounded border-slate-300 text-blue-600 shadow-sm focus:ring-1 focus:ring-blue-400 focus:ring-offset-0"
                          />
                          <span className="min-w-0 flex-1">
                            <span className="block truncate text-xs font-semibold text-slate-800">@{p.nickname}</span>
                            {p.fullName && p.fullName !== p.nickname && (
                              <span className="block truncate text-[10px] text-slate-400">{p.fullName}</span>
                            )}
                          </span>
                            {p.role && (
                              <span className="shrink-0 rounded-full bg-slate-100 px-1.5 py-0.5 text-[9px] font-medium text-slate-500">
                                {ROLE_LABELS[p.role] ?? p.role}
                              </span>
                            )}
                          </label>
                        ))}
                        {filtered.length === 0 && (
                          <p className="px-2.5 py-2 text-[11px] text-slate-400">
                            {specialistOptions.length === 0 ? 'Нет специалистов' : 'Никого не найдено'}
                          </p>
                        )}
                        {filtered.length > 0 && (
                          <p className="sticky bottom-0 border-t border-slate-100 bg-white/90 px-2.5 py-1 text-[10px] text-slate-400">
                            {q ? `Показано ${filtered.length} из ${specialistOptions.length}` : `Всего ${specialistOptions.length}`}
                          </p>
                        )}
                      </>
                    );
                  })()}
                </div>
              </div>
              <div>
                <span className="mb-1 block text-[11px] font-medium text-slate-500">Описание</span>
                <textarea
                  value={newDescription}
                  onChange={(e) => setNewDescription(e.target.value)}
                  onInput={(e) => { const t = e.currentTarget; t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px'; }}
                  placeholder="Текст описания задачи..."
                  rows={2}
                  className="w-full resize-none rounded-lg border border-slate-200 bg-slate-50/80 px-2.5 py-1.5 text-xs text-slate-800 shadow-sm placeholder:text-slate-400 outline-none transition focus:border-slate-400 focus:bg-white focus:ring-2 focus:ring-slate-400/20"
                />
              </div>
              <div>
                <span className="mb-1 block text-[11px] font-medium text-slate-500">Картинка</span>
                <div
                  className="rounded-lg border border-slate-200 bg-slate-50/50 p-2 focus-within:border-slate-400 focus-within:ring-2 focus-within:ring-slate-400/20"
                  onPaste={async (e) => {
                    const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith('image/'));
                    const file = item?.getAsFile();
                    if (!file) return;
                    e.preventDefault();
                    setTaskImageUploading(true);
                    try {
                      const url = await uploadTaskImage(file);
                      setNewImageUrl(url);
                    } catch (err) {
                      void logError('tasks.image.upload.failed', err);
                    } finally {
                      setTaskImageUploading(false);
                    }
                  }}
                >
                  <input
                    ref={newTaskImageInputRef}
                    type="file"
                    accept="image/*"
                    className="hidden"
                    onChange={async (e) => {
                      const file = e.target.files?.[0];
                      if (!file) return;
                      e.target.value = '';
                      setTaskImageUploading(true);
                      try {
                        const url = await uploadTaskImage(file);
                        setNewImageUrl(url);
                      } catch (err) {
                        void logError('tasks.image.upload.failed', err);
                      } finally {
                        setTaskImageUploading(false);
                      }
                    }}
                  />
                  {newImageUrl ? (
                    <>
                      <div className="min-h-20 w-full overflow-hidden rounded bg-slate-100">
                        <img
                          src={newImageUrl}
                          alt=""
                          referrerPolicy="no-referrer"
                          className="max-h-32 w-full object-contain"
                          onLoad={() => setNewImageLoadError(false)}
                          onError={() => setNewImageLoadError(true)}
                        />
                        {newImageLoadError && (
                          <p className="p-1.5 text-center text-[11px] text-amber-600">Не удалось загрузить изображение</p>
                        )}
                      </div>
                      <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                        <button
                          type="button"
                          disabled={taskImageUploading}
                          onClick={() => newTaskImageInputRef.current?.click()}
                          className="rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50"
                        >
                          {taskImageUploading ? 'Загрузка...' : 'Заменить'}
                        </button>
                        <button
                          type="button"
                          onClick={() => { setNewImageUrl(''); setNewImageLoadError(false); }}
                          className="rounded border border-slate-200 px-2 py-1 text-[11px] font-medium text-slate-500 hover:bg-slate-50"
                        >
                          Удалить
                        </button>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="flex flex-wrap items-center gap-1.5">
                        <button
                          type="button"
                          disabled={taskImageUploading}
                          onClick={() => newTaskImageInputRef.current?.click()}
                          className="rounded border border-slate-300 bg-white px-2 py-1 text-[11px] font-medium text-slate-700 shadow-sm hover:bg-slate-50 disabled:opacity-50"
                        >
                          {taskImageUploading ? 'Загрузка...' : 'Выбрать с компьютера'}
                        </button>
                        <span className="text-[11px] text-slate-500">или Ctrl+V</span>
                      </div>
                      <input
                        type="url"
                        value={newImageUrl}
                        onChange={(e) => { setNewImageUrl(e.target.value); setNewImageLoadError(false); }}
                        placeholder="или вставьте ссылку"
                        className="mt-1.5 w-full rounded border border-slate-200 bg-slate-50/50 px-2 py-1 text-xs outline-none focus:border-slate-400"
                      />
                    </>
                  )}
                </div>
              </div>
              <div className="flex gap-1.5 pt-1.5 border-t border-slate-100">
                <button
                  type="button"
                  disabled={addingSaving || !newTitle.trim() || newSpecialists.length === 0}
                  onClick={async () => {
                    await handleAddTask();
                    setShowAddTaskModal(false);
                    setNewTaskColumnId(null);
                  }}
                  className="rounded-lg bg-slate-800 px-3 py-2 text-xs font-medium text-white shadow-md transition hover:bg-slate-700 disabled:opacity-50 disabled:shadow-none"
                >
                  {addingSaving ? 'Сохранение...' : 'Сохранить'}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setShowAddTaskModal(false);
                    setNewTaskColumnId(null);
                    setNewTitle('');
                    setNewProjectId('');
                    setNewSpecialists([]);
                    setNewDescription('');
                    setNewImageUrl('');
                    setAssigneeFilterModal('');
                  }}
                  className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-600 shadow-sm transition hover:bg-slate-50"
                >
                  Отмена
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {modalTask && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/20 p-4 backdrop-blur-sm"
          onClick={() => {
            setTaskModalTaskId(null);
            setEditingResultId(null);
          }}
        >
          <div
            className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-xl border border-gray-200 bg-white shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="sticky top-0 z-10 flex items-center justify-between border-b border-gray-200 bg-white px-4 py-3">
              <h3 className="text-lg font-semibold text-gray-900">Задача</h3>
              <button
                type="button"
                onClick={() => {
                  setTaskModalTaskId(null);
                  setEditingResultId(null);
                }}
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-gray-500 hover:bg-gray-100 hover:text-gray-700"
                aria-label="Закрыть"
              >
                ×
              </button>
            </div>
            <div className="p-4 space-y-4">
              {!modalTask.board_id && (
                <div>
                  {isModalInEditMode ? (
                    <div>
                      <span className="mb-1.5 block text-xs font-medium text-slate-500">Проект</span>
                      <select
                        value={editingProjectId}
                        onChange={(e) => setEditingProjectId(e.target.value)}
                        className="w-full rounded-xl border border-slate-200 bg-slate-50/80 py-2.5 pl-3 pr-9 text-sm text-slate-800 shadow-sm outline-none transition focus:border-slate-400 focus:bg-white focus:ring-2 focus:ring-slate-400/20"
                      >
                        <option value="">Без проекта</option>
                        {projects.map((p) => (
                          <option key={p.id} value={p.id}>{p.client || p.name || 'Без названия'}</option>
                        ))}
                      </select>
                    </div>
                  ) : (
                    <>
                      <p className="text-xs font-medium text-slate-500">Проект</p>
                      <p className="mt-0.5 text-sm font-medium text-slate-700">{modalTask.projectName}</p>
                    </>
                  )}
                </div>
              )}

              <div>
                {isModalInEditMode ? (
                  <>
                    <span className="mb-1.5 block text-xs font-medium text-slate-500">Исполнители</span>
                    <div className="max-h-52 overflow-y-auto rounded-xl border border-slate-200/80 bg-slate-50/60 py-1.5 shadow-sm">
                      {specialistOptions.map((p) => (
                        <label
                          key={p.id}
                          className={`flex cursor-pointer items-center gap-2.5 px-3 py-2 transition-colors ${editingSpecialists.includes(p.value) ? 'bg-blue-50/60' : 'hover:bg-slate-100/50'}`}
                        >
                          <input
                            type="checkbox"
                            checked={editingSpecialists.includes(p.value)}
                            onChange={(e) => {
                              setEditingSpecialists((prev) =>
                                e.target.checked ? [...prev, p.value] : prev.filter((x) => x !== p.value)
                              );
                            }}
                            className="h-4 w-4 shrink-0 rounded-md border-slate-300 text-blue-600 shadow-sm focus:ring-2 focus:ring-blue-400 focus:ring-offset-0"
                          />
                          <span className="min-w-0 flex-1 text-sm font-medium text-slate-700 truncate">@{p.nickname}</span>
                        </label>
                      ))}
                      {specialistOptions.length === 0 && (
                        <p className="px-3 py-2 text-xs text-slate-500">Нет специалистов</p>
                      )}
                    </div>
                  </>
                ) : (
                  <>
                    <p className="text-xs font-medium text-slate-500">Исполнители</p>
                    <p className="mt-0.5 text-sm font-medium text-slate-700">{modalTask.specialistName}</p>
                  </>
                )}
              </div>

              <div>
                <p className="text-xs font-medium text-gray-500">Название</p>
                {isModalInEditMode ? (
                  <input
                    type="text"
                    value={editingTitleValue}
                    onChange={(e) => setEditingTitleValue(e.target.value)}
                    className="mt-0.5 w-full rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-blue-400"
                    placeholder="Название задачи..."
                  />
                ) : (
                  <p className={`break-words text-base font-semibold ${modalTask.status === 'done' ? 'text-gray-400 line-through' : 'text-gray-900'}`}>
                    {modalTask.title}
                  </p>
                )}
              </div>

              <div>
                <p className="text-xs font-medium text-gray-500 mb-1">Описание</p>
                {isModalInEditMode ? (
                  <>
                    <textarea
                      value={editingDescriptionValue}
                      onChange={(e) => setEditingDescriptionValue(e.target.value)}
                      onInput={(e) => { const t = e.currentTarget; t.style.height = 'auto'; t.style.height = t.scrollHeight + 'px'; }}
                      placeholder="Описание..."
                      rows={3}
                      className="w-full resize-none rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-blue-400"
                    />
                    <p className="mt-2 text-xs font-medium text-gray-500">Картинка</p>
                    <div
                      className="mt-0.5 rounded-lg border border-gray-200 bg-gray-50/30 p-2"
                      onPaste={async (e) => {
                        const item = Array.from(e.clipboardData?.items ?? []).find((i) => i.type.startsWith('image/'));
                        const file = item?.getAsFile();
                        if (!file) return;
                        e.preventDefault();
                        setTaskImageUploading(true);
                        try {
                          const url = await uploadTaskImage(file);
                          setEditingImageUrlValue(url);
                        } catch (err) {
                          void logError('tasks.image.upload.failed', err);
                        } finally {
                          setTaskImageUploading(false);
                        }
                      }}
                    >
                      <input
                        ref={editTaskImageInputRef}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={async (e) => {
                          const file = e.target.files?.[0];
                          if (!file) return;
                          e.target.value = '';
                          setTaskImageUploading(true);
                          try {
                            const url = await uploadTaskImage(file);
                            setEditingImageUrlValue(url);
                          } catch (err) {
                            void logError('tasks.image.upload.failed', err);
                          } finally {
                            setTaskImageUploading(false);
                          }
                        }}
                      />
                      {editingImageUrlValue ? (
                        <>
                          <img src={editingImageUrlValue} alt="" className="max-h-40 w-full rounded-lg object-contain" />
                          <div className="mt-2 flex gap-2">
                            <button type="button" disabled={taskImageUploading} onClick={() => editTaskImageInputRef.current?.click()} className="rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50">
                              {taskImageUploading ? 'Загрузка...' : 'Заменить'}
                            </button>
                            <button type="button" onClick={() => { setEditingImageUrlValue(''); }} className="rounded border px-2 py-1 text-xs text-gray-500 hover:bg-gray-50">
                              Удалить
                            </button>
                          </div>
                        </>
                      ) : (
                        <>
                          <button type="button" disabled={taskImageUploading} onClick={() => editTaskImageInputRef.current?.click()} className="rounded border border-gray-300 px-2 py-1 text-xs hover:bg-gray-50">
                            {taskImageUploading ? 'Загрузка...' : 'Выбрать с компьютера'}
                          </button>
                          <span className="ml-2 text-xs text-gray-500">или Ctrl+V</span>
                          <input
                            type="url"
                            value={editingImageUrlValue}
                            onChange={(e) => setEditingImageUrlValue(e.target.value)}
                            placeholder="или ссылка"
                            className="mt-2 w-full rounded border border-gray-200 px-2 py-1 text-sm"
                          />
                        </>
                      )}
                    </div>
                  </>
                ) : (
                  <>
                    {(modalTask.description || modalTask.image_url) ? (
                      <div>
                        {modalTask.description && <p className="whitespace-pre-wrap text-sm text-gray-600">{modalTask.description}</p>}
                        {modalTask.image_url && <img src={modalTask.image_url} alt="" className="mt-2 max-h-48 w-full rounded-lg object-contain" />}
                      </div>
                    ) : (
                      <p className="text-sm text-gray-400">—</p>
                    )}
                  </>
                )}
              </div>

              {userIsLead && (
                <div className="flex flex-wrap items-center justify-between gap-2 pt-2 border-t border-gray-100">
                  <div className="flex flex-wrap items-center gap-2">
                    {isModalInEditMode ? (
                      <>
                        <button
                          type="button"
                          onClick={async () => {
                            await updateTaskTitle(modalTask.id, editingTitleValue);
                            await updateTaskProject(modalTask.id, editingProjectId || null);
                            await updateTaskSpecialist(modalTask.id, editingSpecialists.join(', ').trim() || '');
                            await updateTaskDescriptionAndImage(modalTask.id, editingDescriptionValue, editingImageUrlValue);
                            setIsModalInEditMode(false);
                          }}
                          className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
                        >
                          Сохранить
                        </button>
                        <button
                          type="button"
                          onClick={() => setIsModalInEditMode(false)}
                          className="rounded-lg border border-gray-200 px-4 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50"
                        >
                          Отмена
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        onClick={() => {
                          setIsModalInEditMode(true);
                          setEditingTitleValue(modalTask.title);
                          setEditingProjectId(modalTask.project_id ?? '');
                          setEditingSpecialists((modalTask.specialist ?? '').split(',').map((s) => s.trim()).filter(Boolean));
                          setEditingDescriptionValue(modalTask.description || '');
                          setEditingImageUrlValue(modalTask.image_url || '');
                        }}
                        className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
                      >
                        Редактировать
                      </button>
                    )}
                  </div>
                  {showDeleteTaskConfirm ? (
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-red-600">Удалить задачу?</span>
                      <button
                        type="button"
                        onClick={async () => {
                          await deleteTask(modalTask.id);
                          setTaskModalTaskId(null);
                          setShowDeleteTaskConfirm(false);
                        }}
                        className="rounded-lg bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700"
                      >
                        Да
                      </button>
                      <button
                        type="button"
                        onClick={() => setShowDeleteTaskConfirm(false)}
                        className="rounded-lg border border-gray-200 px-3 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50"
                      >
                        Нет
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setShowDeleteTaskConfirm(true)}
                      className="flex items-center gap-1.5 rounded-lg border border-red-200 px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50 transition-colors"
                    >
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 4h8M5 4V3a1 1 0 011-1h2a1 1 0 011 1v1M6 6.5v3.5M8 6.5v3.5M4 4l.5 7a1 1 0 001 1h3a1 1 0 001-1L10 4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                      Удалить
                    </button>
                  )}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
