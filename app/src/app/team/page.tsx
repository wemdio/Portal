'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { Users, Briefcase, TrendingUp, Clock, User } from 'lucide-react';

interface TeamMember {
  name: string;
  projectCount: number;
  activeProjects: number;
  pausedProjects: number;
}

export default function TeamPage() {
  const [managers, setManagers] = useState<TeamMember[]>([]);
  const [specialists, setSpecialists] = useState<TeamMember[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchTeamData();
  }, []);

  async function fetchTeamData() {
    try {
      const { data: projects, error } = await supabase
        .from('projects')
        .select('manager, specialist, status');

      if (error) throw error;

      // Aggregate by manager
      const managerMap = new Map<string, TeamMember>();
      const specialistMap = new Map<string, TeamMember>();

      projects?.forEach((p) => {
        // Process manager
        if (p.manager) {
          const existing = managerMap.get(p.manager) || { 
            name: p.manager, 
            projectCount: 0, 
            activeProjects: 0, 
            pausedProjects: 0 
          };
          existing.projectCount++;
          if (p.status?.toLowerCase().includes('работ') || p.status?.toLowerCase().includes('тест')) {
            existing.activeProjects++;
          }
          if (p.status?.toLowerCase().includes('пауз')) {
            existing.pausedProjects++;
          }
          managerMap.set(p.manager, existing);
        }

        // Process specialist
        if (p.specialist) {
          const existing = specialistMap.get(p.specialist) || { 
            name: p.specialist, 
            projectCount: 0, 
            activeProjects: 0, 
            pausedProjects: 0 
          };
          existing.projectCount++;
          if (p.status?.toLowerCase().includes('работ') || p.status?.toLowerCase().includes('тест')) {
            existing.activeProjects++;
          }
          if (p.status?.toLowerCase().includes('пауз')) {
            existing.pausedProjects++;
          }
          specialistMap.set(p.specialist, existing);
        }
      });

      // Sort by project count descending
      const sortedManagers = Array.from(managerMap.values()).sort((a, b) => b.projectCount - a.projectCount);
      const sortedSpecialists = Array.from(specialistMap.values()).sort((a, b) => b.projectCount - a.projectCount);

      setManagers(sortedManagers);
      setSpecialists(sortedSpecialists);
    } catch (error) {
      console.error('Error fetching team data:', error);
    } finally {
      setLoading(false);
    }
  }

  const getWorkloadColor = (active: number) => {
    if (active >= 8) return 'text-red-600 bg-red-100';
    if (active >= 5) return 'text-yellow-600 bg-yellow-100';
    return 'text-green-600 bg-green-100';
  };

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold text-gray-900">Команда</h1>
        <p className="mt-1 text-sm text-gray-500">Нагрузка менеджеров и специалистов по проектам</p>
      </div>

      {/* Stats Overview */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm">
          <div className="flex items-center">
            <div className="p-3 rounded-full bg-blue-100">
              <Users className="h-6 w-6 text-blue-600" />
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-500">Менеджеров</p>
              <p className="text-2xl font-semibold text-gray-900">{managers.length}</p>
            </div>
          </div>
        </div>
        <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm">
          <div className="flex items-center">
            <div className="p-3 rounded-full bg-purple-100">
              <User className="h-6 w-6 text-purple-600" />
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-500">Специалистов</p>
              <p className="text-2xl font-semibold text-gray-900">{specialists.length}</p>
            </div>
          </div>
        </div>
        <div className="bg-white p-6 rounded-xl border border-gray-200 shadow-sm">
          <div className="flex items-center">
            <div className="p-3 rounded-full bg-green-100">
              <Briefcase className="h-6 w-6 text-green-600" />
            </div>
            <div className="ml-4">
              <p className="text-sm font-medium text-gray-500">Всего назначений</p>
              <p className="text-2xl font-semibold text-gray-900">
                {managers.reduce((sum, m) => sum + m.projectCount, 0) + specialists.reduce((sum, s) => sum + s.projectCount, 0)}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Managers Section */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 bg-gray-50">
          <h2 className="text-lg font-semibold text-gray-900 flex items-center">
            <Users className="h-5 w-5 mr-2 text-blue-600" />
            Менеджеры (Контролирует)
          </h2>
        </div>
        <div className="divide-y divide-gray-200">
          {managers.map((member) => (
            <div key={member.name} className="px-6 py-4 flex items-center justify-between hover:bg-gray-50">
              <div className="flex items-center">
                <div className="h-10 w-10 rounded-full bg-blue-600 flex items-center justify-center text-white font-medium">
                  {member.name.charAt(0).toUpperCase()}
                </div>
                <div className="ml-4">
                  <p className="text-sm font-medium text-gray-900">{member.name}</p>
                  <p className="text-xs text-gray-500">
                    {member.activeProjects} активных · {member.pausedProjects} на паузе
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-4">
                <div className={`px-3 py-1 rounded-full text-sm font-medium ${getWorkloadColor(member.activeProjects)}`}>
                  {member.activeProjects} активных
                </div>
                <div className="text-right">
                  <p className="text-lg font-semibold text-gray-900">{member.projectCount}</p>
                  <p className="text-xs text-gray-500">проектов</p>
                </div>
              </div>
            </div>
          ))}
          {managers.length === 0 && (
            <div className="px-6 py-8 text-center text-gray-500">Нет данных о менеджерах</div>
          )}
        </div>
      </div>

      {/* Specialists Section */}
      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-200 bg-gray-50">
          <h2 className="text-lg font-semibold text-gray-900 flex items-center">
            <User className="h-5 w-5 mr-2 text-purple-600" />
            Специалисты (Спец проекта)
          </h2>
        </div>
        <div className="divide-y divide-gray-200">
          {specialists.map((member) => (
            <div key={member.name} className="px-6 py-4 flex items-center justify-between hover:bg-gray-50">
              <div className="flex items-center">
                <div className="h-10 w-10 rounded-full bg-purple-600 flex items-center justify-center text-white font-medium">
                  {member.name.charAt(0).toUpperCase()}
                </div>
                <div className="ml-4">
                  <p className="text-sm font-medium text-gray-900">{member.name}</p>
                  <p className="text-xs text-gray-500">
                    {member.activeProjects} активных · {member.pausedProjects} на паузе
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-4">
                <div className={`px-3 py-1 rounded-full text-sm font-medium ${getWorkloadColor(member.activeProjects)}`}>
                  {member.activeProjects} активных
                </div>
                <div className="text-right">
                  <p className="text-lg font-semibold text-gray-900">{member.projectCount}</p>
                  <p className="text-xs text-gray-500">проектов</p>
                </div>
              </div>
            </div>
          ))}
          {specialists.length === 0 && (
            <div className="px-6 py-8 text-center text-gray-500">Нет данных о специалистах</div>
          )}
        </div>
      </div>
    </div>
  );
}


