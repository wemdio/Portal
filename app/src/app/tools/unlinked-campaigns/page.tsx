import { redirect } from 'next/navigation';

/** Экран переехал во вкладку «Персонализированных ответов»; старые ссылки ведут туда. */
export default function UnlinkedCampaignsPage() {
  redirect('/tools/reply-personalization?tab=campaigns');
}
