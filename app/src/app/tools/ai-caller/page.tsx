'use client';

import { useState, useRef, useCallback } from 'react';
import { supabase } from '@/lib/supabaseClient';
import { Phone, Bot, History, Users, BarChart3 } from 'lucide-react';
import { TestCallTab } from '@/components/ai-caller/TestCallTab';
import { AssistantsTab } from '@/components/ai-caller/AssistantsTab';
import { CampaignsTab } from '@/components/ai-caller/CampaignsTab';
import { AnalyticsTab } from '@/components/ai-caller/AnalyticsTab';
import { CallHistoryTab } from '@/components/ai-caller/CallHistoryTab';
import type { AiCallerTab, VapiAssistant, VapiPhoneNumber, VapiCall } from '@/types/ai-caller';

const TABS: { id: AiCallerTab; label: string; icon: typeof Phone }[] = [
  { id: 'test-call', label: 'Тестовый звонок', icon: Phone },
  { id: 'assistants', label: 'Ассистенты', icon: Bot },
  { id: 'campaigns', label: 'Обзвон', icon: Users },
  { id: 'analytics', label: 'Аналитика', icon: BarChart3 },
  { id: 'history', label: 'История', icon: History },
];

async function getToken() {
  const { data: { session } } = await supabase.auth.getSession();
  return session?.access_token ?? '';
}

export default function AiCallerPage() {
  const [activeTab, setActiveTab] = useState<AiCallerTab>('test-call');
  const [assistants, setAssistants] = useState<VapiAssistant[]>([]);
  const [phoneNumbers, setPhoneNumbers] = useState<VapiPhoneNumber[]>([]);
  const [calls, setCalls] = useState<VapiCall[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingCalls, setLoadingCalls] = useState(false);

  const coreLoaded = useRef<boolean | null>(null);
  const callsLoaded = useRef<boolean | null>(null);

  const fetchCore = useCallback(async () => {
    setLoading(true);
    try {
      const token = await getToken();
      const headers = { Authorization: `Bearer ${token}` };

      const [assistantsRes, phonesRes] = await Promise.all([
        fetch('/api/ai-caller/assistants', { headers }),
        fetch('/api/ai-caller/phone-numbers', { headers }),
      ]);

      const assistantsData = await assistantsRes.json();
      const phonesData = await phonesRes.json();

      setAssistants((assistantsData.assistants ?? []) as VapiAssistant[]);
      setPhoneNumbers((phonesData.phoneNumbers ?? []) as VapiPhoneNumber[]);
    } catch {
      // Errors shown in child components
    }
    setLoading(false);
  }, []);

  const fetchCalls = useCallback(async () => {
    setLoadingCalls(true);
    try {
      const token = await getToken();
      const res = await fetch('/api/ai-caller/calls?limit=30', {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await res.json();
      setCalls((data.calls ?? []) as VapiCall[]);
    } catch {
      // ignore
    }
    setLoadingCalls(false);
  }, []);

  // Initial load on first render (React 19 ref-init pattern)
  if (coreLoaded.current == null) {
    coreLoaded.current = true;
    fetchCore();
  }

  function handleTabChange(tab: AiCallerTab) {
    setActiveTab(tab);
    if ((tab === 'history' || tab === 'analytics') && callsLoaded.current == null) {
      callsLoaded.current = true;
      fetchCalls();
    }
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">AI Звонилка</h1>
        <p className="text-sm text-gray-500">
          Управление AI-ассистентами, тестовые звонки, обзвон баз и аналитика.
        </p>
      </div>

      {/* Tabs */}
      <div className="border-b border-gray-200">
        <nav className="-mb-px flex gap-4 overflow-x-auto no-scrollbar" aria-label="Tabs">
          {TABS.map((tab) => {
            const Icon = tab.icon;
            const isActive = activeTab === tab.id;
            return (
              <button
                key={tab.id}
                onClick={() => handleTabChange(tab.id)}
                className={`inline-flex items-center gap-2 border-b-2 py-3 px-1 text-sm font-medium whitespace-nowrap transition-colors
                  ${
                    isActive
                      ? 'border-blue-500 text-blue-600'
                      : 'border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300'
                  }
                `}
              >
                <Icon className="h-4 w-4" />
                {tab.label}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Tab Content */}
      {activeTab === 'test-call' && (
        <TestCallTab
          assistants={assistants}
          phoneNumbers={phoneNumbers}
          loading={loading}
        />
      )}

      {activeTab === 'assistants' && (
        <AssistantsTab
          assistants={assistants}
          loading={loading}
          onRefresh={fetchCore}
        />
      )}

      {activeTab === 'campaigns' && (
        <CampaignsTab
          assistants={assistants}
          phoneNumbers={phoneNumbers}
          loading={loading}
        />
      )}

      {activeTab === 'analytics' && (
        <AnalyticsTab
          calls={calls}
          loading={loading || loadingCalls}
          onRefreshCalls={fetchCalls}
        />
      )}

      {activeTab === 'history' && (
        <CallHistoryTab
          calls={calls}
          assistants={assistants}
          loading={loading || loadingCalls}
          onRefresh={fetchCalls}
        />
      )}
    </div>
  );
}
