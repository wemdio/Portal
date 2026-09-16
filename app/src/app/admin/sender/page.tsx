import { SenderView } from '@/components/sender/SenderView';

// Живёт в админке, а не на странице инструментов: подключение почт провайдера —
// административная операция. Доступ ограничен layout'ом /admin (только admin).
export default function SenderPage() {
  return <SenderView />;
}
