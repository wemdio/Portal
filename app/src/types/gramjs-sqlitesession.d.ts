declare module 'gramjs-sqlitesession' {
  const SQLiteSession: new (path: string) => import('telegram/sessions').Session;
  export default SQLiteSession;
}
