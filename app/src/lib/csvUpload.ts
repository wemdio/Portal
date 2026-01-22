import Papa from 'papaparse';
import { supabase } from '@/lib/supabaseClient';

export interface Project {
  name: string;
  description: string;
  region: string;
  lead_source: string;
  payment_method: string;
  work_format: string;
  budget: string;
  contract_date: string;
  launch_date: string;
  deadline: string;
  kpi_plan: string;
  kpi_fact: string;
  status: string;
  specialist: string;
  manager: string;
  weekly_tasks: string;
  comment_elvira: string;
  comment_anya: string;
}

// Helper to normalize keys (remove BOM, newlines, extra spaces, special chars)
const normalizeKey = (key: string) => {
  return key
    .replace(/^\uFEFF/, '') // Remove BOM
    .replace(/\n/g, ' ')    // Replace newlines with space
    .replace(/\r/g, ' ')    // Replace carriage returns
    .replace(/\s+/g, ' ')   // Collapse multiple spaces
    .trim();                // Trim whitespace
};

export async function uploadCSV(file: File) {
  return new Promise<{ count: number; headers?: string[] }>((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      preview: 0, // Parse all rows
      complete: async (results) => {
        try {
          const rawRows = results.data as any[];
          
          if (!rawRows || rawRows.length === 0) {
            resolve({ count: 0 });
            return;
          }

          // Debugging: Get headers from the first row keys
          const actualHeaders = Object.keys(rawRows[0]);
          console.log('Detected headers:', actualHeaders);
          
          // Create a map for normalized headers to actual headers of the first row
          const headerMap: Record<string, string> = {};
          actualHeaders.forEach(key => {
            headerMap[normalizeKey(key)] = key;
          });

          console.log('Normalized Header Map:', headerMap);

          // Helper to get value using normalized key
          const getValue = (row: any, targetKey: string) => {
            // Try exact match first
            if (row[targetKey]) return row[targetKey];
            
            // Try normalized match
            const actualKey = headerMap[normalizeKey(targetKey)];
            if (actualKey && row[actualKey] !== undefined) return row[actualKey];

            // Fuzzy fallback: look for partial match in keys
            const foundKey = Object.keys(row).find(k => 
              normalizeKey(k).toLowerCase().includes(normalizeKey(targetKey).toLowerCase())
            );
            return foundKey ? row[foundKey] : '';
          };

          const formattedData = rawRows.map(row => {
            const name = getValue(row, 'Название');
            // If name is missing, try to find it in the first column if typical structure
            // But let's stick to key mapping for now.
            
            return {
              name: name || '',
              description: getValue(row, 'Что за проект (краткое описание)') || '',
              region: getValue(row, 'Направление') || '',
              lead_source: getValue(row, 'Откуда лид') || '',
              payment_method: getValue(row, 'Способ оплаты') || '',
              work_format: getValue(row, 'Формат работы') || '',
              budget: getValue(row, 'Сумма услуг') || '',
              contract_date: getValue(row, 'Дата договора') || '',
              launch_date: getValue(row, 'Дата запуска') || '',
              deadline: getValue(row, 'Дедлайн') || '',
              kpi_plan: getValue(row, 'KPI план (мес)') || '',
              kpi_fact: getValue(row, 'KPI факт') || '', // Simplified key for fuzzy match
              status: getValue(row, 'Статус проекта') || 'New',
              specialist: getValue(row, 'Спец проекта') || '',
              manager: getValue(row, 'Контролирует') || '',
              weekly_tasks: getValue(row, 'Задачи на неделю') || '',
              comment_elvira: getValue(row, 'Комментарий от Эльвиры') || '',
              comment_anya: getValue(row, 'Комментарий от Ани') || ''
            };
          }).filter(p => p.name && p.name.trim() !== ''); // Filter out empty rows

          console.log('Formatted rows to insert:', formattedData.length);

          if (formattedData.length === 0) {
             // Return headers to show to user for debugging
             resolve({ count: 0, headers: actualHeaders });
             return;
          }

          const { error } = await supabase
            .from('projects')
            .insert(formattedData);

          if (error) {
            console.error('Supabase insert error:', error);
            throw error;
          }
          
          resolve({ count: formattedData.length });
        } catch (error) {
          reject(error);
        }
      },
      error: (error) => {
        reject(error);
      }
    });
  });
}
