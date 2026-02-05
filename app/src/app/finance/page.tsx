'use client';

import { useEffect, useState, useMemo } from 'react';
import { supabase } from '@/lib/supabaseClient';

interface ProjectFinancials {
  id: string;
  name: string;
  client: string;
  specialist: string;
  status: string;
  budget: number;
  marginPercent: number;
  marginValue: number;
  cost: number;
  roi: number;
}

interface ClientFinancials {
  name: string;
  revenue: number;
  margin: number;
  cost: number;
  roi: number;
  projectCount: number;
}

interface SpecialistFinancials {
  name: string;
  revenue: number;
  margin: number;
  cost: number; // How much we pay them (or allocated cost)
  roi: number;
  projectCount: number;
}

type ProjectRow = {
  id?: string | number | null;
  name?: string | null;
  client?: string | null;
  specialist?: string | null;
  status?: string | null;
  budget?: string | number | null;
  margin?: string | number | null;
};

export default function FinancePage() {
  const [financials, setFinancials] = useState<ProjectFinancials[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchFinancialData();
  }, []);

  async function fetchFinancialData() {
    try {
      const { data, error } = await supabase
        .from('projects')
        .select('*');

      if (error) throw error;

      const rows = (data || []) as ProjectRow[];
      const parsedData: ProjectFinancials[] = rows.map((p) => {
        // Parse Budget
        const budgetStr = p.budget?.toString().replace(/\s/g, '').replace(/[^0-9.]/g, '') || '0';
        const budget = parseFloat(budgetStr) || 0;

        // Parse Margin
        let marginPercent = 0;
        const marginStr = p.margin?.toString().replace(/\s/g, '').replace(',', '.') || '';
        if (marginStr.includes('%')) {
          marginPercent = parseFloat(marginStr.replace('%', '')) || 0;
        } else if (marginStr) {
          const val = parseFloat(marginStr);
          // Heuristic: if value < 1 (e.g. 0.4), it's 40%. If > 1 (e.g. 40), it's 40%.
          marginPercent = val <= 1 && val > 0 ? val * 100 : val;
        }

        const marginValue = (budget * marginPercent) / 100;
        const cost = budget - marginValue;
        const roi = cost > 0 ? (marginValue / cost) * 100 : 0;

        return {
          id: String(p.id ?? ''),
          name: p.name || 'Без названия',
          client: p.client || 'Неизвестный клиент',
          specialist: p.specialist || 'Не назначен',
          status: p.status || 'Не указан',
          budget,
          marginPercent,
          marginValue,
          cost,
          roi
        };
      });

      // Filter out cancelled projects? Or keep them? 
      // User likely wants to see financials for active/completed projects.
      // Let's exclude 'Отменен' and maybe 'Подготовка' if budget is not real yet?
      // For now, let's keep everything that has a budget > 0.
      const activeFinancials = parsedData.filter(p => p.budget > 0 && p.status !== 'Отменен');

      setFinancials(activeFinancials);
    } catch (error) {
      console.error('Error fetching financials:', error);
    } finally {
      setLoading(false);
    }
  }

  const stats = useMemo(() => {
    const totalRevenue = financials.reduce((sum, item) => sum + item.budget, 0);
    const totalMargin = financials.reduce((sum, item) => sum + item.marginValue, 0);
    const totalCost = financials.reduce((sum, item) => sum + item.cost, 0);
    const averageMarginPercent = totalRevenue > 0 ? (totalMargin / totalRevenue) * 100 : 0;
    const totalROI = totalCost > 0 ? (totalMargin / totalCost) * 100 : 0;

    return { totalRevenue, totalMargin, totalCost, averageMarginPercent, totalROI };
  }, [financials]);

  const clientStats = useMemo(() => {
    const map = new Map<string, ClientFinancials>();
    financials.forEach(item => {
      const existing = map.get(item.client) || {
        name: item.client,
        revenue: 0,
        margin: 0,
        cost: 0,
        roi: 0,
        projectCount: 0
      };
      existing.revenue += item.budget;
      existing.margin += item.marginValue;
      existing.cost += item.cost;
      existing.projectCount += 1;
      map.set(item.client, existing);
    });

    return Array.from(map.values())
      .map(c => ({
        ...c,
        roi: c.cost > 0 ? (c.margin / c.cost) * 100 : 0
      }))
      .sort((a, b) => b.revenue - a.revenue);
  }, [financials]);

  const specialistStats = useMemo(() => {
    const map = new Map<string, SpecialistFinancials>();
    financials.forEach(item => {
      if (!item.specialist || item.specialist === 'Не назначен') return;
      const existing = map.get(item.specialist) || {
        name: item.specialist,
        revenue: 0,
        margin: 0,
        cost: 0,
        roi: 0,
        projectCount: 0
      };
      existing.revenue += item.budget;
      existing.margin += item.marginValue;
      existing.cost += item.cost;
      existing.projectCount += 1;
      map.set(item.specialist, existing);
    });
    
    return Array.from(map.values())
      .map(s => ({
        ...s,
        roi: s.cost > 0 ? (s.margin / s.cost) * 100 : 0
      }))
      .sort((a, b) => b.margin - a.margin); // Sort by who brings most margin
  }, [financials]);

  const formatCurrency = (val: number) => {
    return new Intl.NumberFormat('ru-RU', {
      style: 'currency',
      currency: 'RUB',
      maximumFractionDigits: 0
    }).format(val);
  };

  const formatPercent = (val: number) => {
    return `${val.toFixed(1)}%`;
  };

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center">
        <div className="text-gray-400 text-sm">Загрузка...</div>
      </div>
    );
  }

  return (
    <div className="space-y-8 max-w-[1600px] mx-auto">
      <div>
        <h1 className="text-3xl font-bold tracking-tight text-gray-900">Финансы</h1>
        <p className="mt-1 text-sm text-gray-500">
          Финэкран фаундера: выручка, маржа, рентабельность
        </p>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="bg-white p-5 rounded-2xl border border-gray-200 shadow-sm">
          <div className="flex items-center gap-3 mb-2">
            <span className="text-sm font-medium text-gray-500">Общая выручка</span>
          </div>
          <p className="text-2xl font-bold text-gray-900">{formatCurrency(stats.totalRevenue)}</p>
        </div>

        <div className="bg-white p-5 rounded-2xl border border-gray-200 shadow-sm">
          <div className="flex items-center gap-3 mb-2">
            <span className="text-sm font-medium text-gray-500">Валовая прибыль (Маржа)</span>
          </div>
          <p className="text-2xl font-bold text-gray-900">{formatCurrency(stats.totalMargin)}</p>
          <p className="text-xs text-emerald-600 mt-1 font-medium">
            {formatPercent(stats.averageMarginPercent)} средняя рентабельность
          </p>
        </div>

        <div className="bg-white p-5 rounded-2xl border border-gray-200 shadow-sm">
          <div className="flex items-center gap-3 mb-2">
            <span className="text-sm font-medium text-gray-500">Себестоимость (Спецы)</span>
          </div>
          <p className="text-2xl font-bold text-gray-900">{formatCurrency(stats.totalCost)}</p>
        </div>

        <div className="bg-white p-5 rounded-2xl border border-gray-200 shadow-sm">
          <div className="flex items-center gap-3 mb-2">
            <span className="text-sm font-medium text-gray-500">ROI Агентства</span>
          </div>
          <p className="text-2xl font-bold text-gray-900">{formatPercent(stats.totalROI)}</p>
          <p className="text-xs text-gray-400 mt-1">на вложенный рубль</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Clients Table */}
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden flex flex-col h-full">
          <div className="px-6 py-4 border-b border-gray-100 bg-gray-50/50 flex items-center justify-between">
            <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
              Выручка по клиентам
            </h2>
          </div>
          <div className="overflow-x-auto flex-1">
            <table className="min-w-full divide-y divide-gray-100">
              <thead className="bg-gray-50/50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Клиент</th>
                  <th className="px-6 py-3 text-right text-xs font-semibold text-gray-500 uppercase">Проекты</th>
                  <th className="px-6 py-3 text-right text-xs font-semibold text-gray-500 uppercase">Выручка</th>
                  <th className="px-6 py-3 text-right text-xs font-semibold text-gray-500 uppercase">Маржа</th>
                  <th className="px-6 py-3 text-right text-xs font-semibold text-gray-500 uppercase">ROI</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50 bg-white">
                {clientStats.map((client) => (
                  <tr key={client.name} className="hover:bg-gray-50/50">
                    <td className="px-6 py-3 text-sm font-medium text-gray-900">{client.name}</td>
                    <td className="px-6 py-3 text-right text-sm text-gray-500">{client.projectCount}</td>
                    <td className="px-6 py-3 text-right text-sm text-gray-900 font-medium">{formatCurrency(client.revenue)}</td>
                    <td className="px-6 py-3 text-right text-sm text-emerald-600 font-medium">{formatCurrency(client.margin)}</td>
                    <td className="px-6 py-3 text-right text-sm">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                        client.roi >= 100 
                          ? 'bg-emerald-50 text-emerald-700' 
                          : client.roi >= 50 
                            ? 'bg-blue-50 text-blue-700'
                            : 'bg-orange-50 text-orange-700'
                      }`}>
                        {formatPercent(client.roi)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Specialists Table - Resource Eaters vs Providers */}
        <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden flex flex-col h-full">
          <div className="px-6 py-4 border-b border-gray-100 bg-gray-50/50 flex items-center justify-between">
            <h2 className="text-lg font-bold text-gray-900 flex items-center gap-2">
              Эффективность команды
            </h2>
          </div>
          <div className="overflow-x-auto flex-1">
            <table className="min-w-full divide-y divide-gray-100">
              <thead className="bg-gray-50/50">
                <tr>
                  <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Специалист</th>
                  <th className="px-6 py-3 text-right text-xs font-semibold text-gray-500 uppercase">Себестоимость</th>
                  <th className="px-6 py-3 text-right text-xs font-semibold text-gray-500 uppercase">Принес маржи</th>
                  <th className="px-6 py-3 text-right text-xs font-semibold text-gray-500 uppercase">ROI</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50 bg-white">
                {specialistStats.map((spec) => (
                  <tr key={spec.name} className="hover:bg-gray-50/50">
                    <td className="px-6 py-3 text-sm font-medium text-gray-900">{spec.name}</td>
                    <td className="px-6 py-3 text-right text-sm text-gray-500">{formatCurrency(spec.cost)}</td>
                    <td className="px-6 py-3 text-right text-sm text-emerald-600 font-medium">{formatCurrency(spec.margin)}</td>
                    <td className="px-6 py-3 text-right text-sm">
                      <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${
                        spec.roi >= 100 
                          ? 'bg-emerald-50 text-emerald-700' 
                          : spec.roi >= 50 
                            ? 'bg-blue-50 text-blue-700'
                            : 'bg-orange-50 text-orange-700'
                      }`}>
                        {spec.roi >= 100 ? <span className="mr-1">↗</span> : <span className="mr-1">↘</span>}
                        {formatPercent(spec.roi)}
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Full Projects Table */}
      <div className="bg-white rounded-2xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 bg-gray-50/50">
          <h2 className="text-lg font-bold text-gray-900">Детализация по проектам</h2>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-100">
            <thead className="bg-gray-50/50">
              <tr>
                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Проект</th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-gray-500 uppercase">Клиент</th>
                <th className="px-6 py-3 text-right text-xs font-semibold text-gray-500 uppercase">Бюджет</th>
                <th className="px-6 py-3 text-right text-xs font-semibold text-gray-500 uppercase">Маржа %</th>
                <th className="px-6 py-3 text-right text-xs font-semibold text-gray-500 uppercase">Маржа ₽</th>
                <th className="px-6 py-3 text-right text-xs font-semibold text-gray-500 uppercase">Себестоимость</th>
                <th className="px-6 py-3 text-right text-xs font-semibold text-gray-500 uppercase">ROI</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50 bg-white">
              {financials.map((project) => (
                <tr key={project.id} className="hover:bg-gray-50/50">
                  <td className="px-6 py-3 text-sm font-medium text-gray-900 max-w-[200px] truncate" title={project.name}>
                    {project.name}
                  </td>
                  <td className="px-6 py-3 text-sm text-gray-500">{project.client}</td>
                  <td className="px-6 py-3 text-right text-sm text-gray-900 font-medium">{formatCurrency(project.budget)}</td>
                  <td className="px-6 py-3 text-right text-sm text-gray-500">{formatPercent(project.marginPercent)}</td>
                  <td className="px-6 py-3 text-right text-sm text-emerald-600 font-medium">{formatCurrency(project.marginValue)}</td>
                  <td className="px-6 py-3 text-right text-sm text-gray-500">{formatCurrency(project.cost)}</td>
                  <td className="px-6 py-3 text-right text-sm">
                    <span className={`font-medium ${project.roi >= 100 ? 'text-emerald-600' : 'text-gray-600'}`}>
                      {formatPercent(project.roi)}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
