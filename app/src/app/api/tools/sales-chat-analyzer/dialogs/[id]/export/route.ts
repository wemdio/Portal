import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { supabaseAdmin } from '@/lib/supabaseAdmin';
import { requireSalesChatAccess } from '@/lib/salesChatAnalyzer/apiGuard';
import { createMainS3DownloadUrl } from '@/lib/mainS3Server';

export const dynamic = 'force-dynamic';
export const runtime = 'nodejs';

const PAGE_SIZE = 1000;
const ATTACHMENT_URL_TTL_SECONDS = 60 * 60 * 24 * 7;

interface DialogRow {
  id: string;
  tg_peer_id: number;
  peer_title: string | null;
  peer_username: string | null;
}

interface MessageRow {
  id: string;
  dialog_id: string;
  tg_message_id: number;
  direction: 'in' | 'out';
  sender_name: string | null;
  text: string | null;
  media_type: string | null;
  sent_at: string;
}

interface AttachmentRow {
  id: string;
  message_id: string | null;
  dialog_id: string;
  tg_message_id: number;
  media_type: string;
  file_name: string | null;
  mime_type: string | null;
  file_size_bytes: number | null;
  s3_bucket: string | null;
  s3_key: string | null;
  status: 'uploaded' | 'skipped' | 'error';
  error_message: string | null;
}

function jsonError(message: string, status: number) {
  return NextResponse.json({ error: message }, { status });
}

function sanitizeFilename(value: string): string {
  return value
    .trim()
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .slice(0, 140);
}

function formatDate(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatBytes(value: number | null): string {
  if (!value || value < 0) return '';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

async function fetchMessages(dialogId: string): Promise<MessageRow[]> {
  const rows: MessageRow[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await supabaseAdmin!
      .from('sales_chat_messages')
      .select('id,dialog_id,tg_message_id,direction,sender_name,text,media_type,sent_at')
      .eq('dialog_id', dialogId)
      .order('sent_at', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as MessageRow[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

async function fetchAttachments(dialogId: string): Promise<AttachmentRow[]> {
  const rows: AttachmentRow[] = [];
  for (let offset = 0; ; offset += PAGE_SIZE) {
    const { data, error } = await supabaseAdmin!
      .from('sales_chat_message_attachments')
      .select(
        'id,message_id,dialog_id,tg_message_id,media_type,file_name,mime_type,file_size_bytes,s3_bucket,s3_key,status,error_message',
      )
      .eq('dialog_id', dialogId)
      .order('tg_message_id', { ascending: true })
      .range(offset, offset + PAGE_SIZE - 1);
    if (error) throw new Error(error.message);
    const page = (data ?? []) as AttachmentRow[];
    rows.push(...page);
    if (page.length < PAGE_SIZE) break;
  }
  return rows;
}

async function buildDocx(params: {
  dialog: DialogRow;
  messages: MessageRow[];
  attachments: AttachmentRow[];
}): Promise<Buffer> {
  const { Document, ExternalHyperlink, HeadingLevel, Packer, Paragraph, TextRun } = await import('docx');
  const children: InstanceType<typeof Paragraph>[] = [];
  const byMessage = new Map<number, AttachmentRow[]>();

  for (const attachment of params.attachments) {
    const list = byMessage.get(attachment.tg_message_id) ?? [];
    list.push(attachment);
    byMessage.set(attachment.tg_message_id, list);
  }

  const title = params.dialog.peer_title ?? `Диалог ${params.dialog.tg_peer_id}`;
  children.push(new Paragraph({ text: `Переписка: ${title}`, heading: HeadingLevel.HEADING_1 }));
  if (params.dialog.peer_username) {
    children.push(new Paragraph({ children: [new TextRun({ text: `Telegram: @${params.dialog.peer_username}` })] }));
  }
  children.push(
    new Paragraph({
      children: [
        new TextRun({
          text: `Сообщений: ${params.messages.length}. Файлы хранятся в S3; ссылки на скачивание действуют 7 дней с момента экспорта.`,
          italics: true,
          color: '666666',
        }),
      ],
    }),
  );
  children.push(new Paragraph({ text: '' }));

  for (const message of params.messages) {
    const who = message.sender_name ?? (message.direction === 'out' ? 'Менеджер' : 'Собеседник');
    children.push(
      new Paragraph({
        children: [
          new TextRun({ text: `[${formatDate(message.sent_at)}] ${who}`, bold: true }),
        ],
      }),
    );

    if (message.text?.trim()) {
      const lines = message.text.trim().split(/\r?\n/);
      children.push(
        new Paragraph({
          children: lines.map((line, i) => new TextRun({ text: line || ' ', break: i === 0 ? 0 : 1 })),
        }),
      );
    }

    const attachments = byMessage.get(message.tg_message_id) ?? [];
    if (attachments.length === 0 && message.media_type) {
      children.push(new Paragraph({ children: [new TextRun({ text: `[${message.media_type}]`, italics: true })] }));
    }

    for (const attachment of attachments) {
      const fileName = attachment.file_name ?? `telegram-document-${attachment.tg_message_id}`;
      const meta = [attachment.mime_type, formatBytes(attachment.file_size_bytes)].filter(Boolean).join(', ');

      if (attachment.status === 'uploaded' && attachment.s3_key) {
        let url: string | null = null;
        try {
          url = await createMainS3DownloadUrl({
            key: attachment.s3_key,
            expiresInSeconds: ATTACHMENT_URL_TTL_SECONDS,
            downloadFilename: fileName,
          });
        } catch {
          url = null;
        }

        children.push(
          new Paragraph({
            children: [
              new TextRun({ text: `Файл: ${fileName}${meta ? ` (${meta}) ` : ' '}`, italics: true }),
              ...(url
                ? [
                    new ExternalHyperlink({
                      link: url,
                      children: [new TextRun({ text: 'скачать', color: '0563C1', underline: {} })],
                    }),
                  ]
                : [new TextRun({ text: 'ссылка временно недоступна' })]),
            ],
          }),
        );
      } else {
        children.push(
          new Paragraph({
            children: [
              new TextRun({
                text: `Файл: ${fileName}${meta ? ` (${meta})` : ''} - не выгружен: ${
                  attachment.error_message ?? attachment.status
                }`,
                italics: true,
                color: '9A3412',
              }),
            ],
          }),
        );
      }
    }

    children.push(new Paragraph({ text: '' }));
  }

  const doc = new Document({ sections: [{ properties: {}, children }] });
  const blob = await Packer.toBuffer(doc);
  return Buffer.from(blob);
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireSalesChatAccess(req);
  if (!guard.ok) return jsonError(guard.error, guard.status);

  const { id } = await params;
  if (!id) return jsonError('Missing id', 400);

  const format = (req.nextUrl.searchParams.get('format') ?? 'docx').toLowerCase();
  if (format !== 'docx') return jsonError('Поддерживается только формат docx.', 400);

  const { data: dialog, error } = await supabaseAdmin!
    .from('sales_chat_dialogs')
    .select('id,tg_peer_id,peer_title,peer_username')
    .eq('id', id)
    .single();
  if (error) return jsonError(error.message, error.code === 'PGRST116' ? 404 : 500);

  try {
    const [messages, attachments] = await Promise.all([
      fetchMessages(id),
      fetchAttachments(id),
    ]);
    const buffer = await buildDocx({ dialog: dialog as DialogRow, messages, attachments });
    const baseName = sanitizeFilename(`Переписка ${dialog.peer_title ?? dialog.tg_peer_id}`);

    return new NextResponse(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(baseName + '.docx')}`,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return jsonError(message, 500);
  }
}
