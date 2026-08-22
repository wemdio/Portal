/**
 * One-shot copier: specialist Hypothesis Engine → isolated Vertical Engine v2.
 * Does not copy ENG autopilot/auto-pipeline modules.
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const appSrc = path.join(root, 'app', 'src');

function walk(dir) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function transform(source, extra = {}) {
  let s = source;
  s = s.replaceAll('HypothesisEngineView', 'VeEngineWorkspace');
  s = s.replaceAll('@/lib/hypothesisEngine', '@/lib/verticalEngineV2');
  s = s.replaceAll('@/components/hypothesis-engine', '@/components/vertical-engine-v2/engine');
  s = s.replaceAll('/api/tools/hypothesis-engine', '/api/tools/vertical-engine-v2');
  s = s.replaceAll('tools.hypothesis-engine', 'tools.vertical-engine-v2');
  s = s.replaceAll('hypothesis-engine', 'vertical-engine-v2');
  s = s.replaceAll('hypothesisEngine', 'verticalEngineV2');
  s = s.replaceAll('HypothesisEngine', 'VerticalEngineV2');
  s = s.replaceAll('HE_MODEL_', 'VE_MODEL_');
  s = s.replaceAll('HE_WORKER_', 'VE_WORKER_');
  s = s.replaceAll('HE_RESEARCH_', 'VE_RESEARCH_');
  s = s.replaceAll('HE_API', 'VE_API');
  s = s.replaceAll('heCall', 'veEngineCall');
  s = s.replaceAll('hePost', 'veEnginePost');
  s = s.replaceAll('hePatch', 'veEnginePatch');
  s = s.replaceAll('heDelete', 'veEngineDelete');
  s = s.replaceAll('he_', 've_');
  s = s.replaceAll('created_by', 'created_by');
  s = s.replace(/He(?=[A-Z])/g, 'Ve');
  s = s.replaceAll('HE_', 'VE_');
  if (extra.stripAutopilot) {
    s = s.replace(/import \{ enqueueAutopilotFollowups \} from '[^']+';\r?\n/, '');
    s = s.replace(
      /\n\s*\/\/ Автопилот ENG[\s\S]*?enqueueAutopilotFollowups\(db, job\);[\s\S]*?\n  \} catch \(e\) \{[\s\S]*?\n  \}\r?\n/,
      '\n',
    );
  }
  return s;
}

function copyFile(from, to, extra) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.writeFileSync(to, transform(fs.readFileSync(from, 'utf8'), extra), 'utf8');
}

const skipLib = new Set([
  'websiteUrl.ts',
  'projects.ts',
  'types.legacy.ts',
  'legacyArchive.ts',
  'legacyLinks.ts',
  'autopilotNext.ts',
  'autoPipeline.ts',
  'engDashboard.ts',
]);

const heLib = path.join(appSrc, 'lib', 'hypothesisEngine');
const veLib = path.join(appSrc, 'lib', 'verticalEngineV2');
for (const file of walk(heLib)) {
  const rel = path.relative(heLib, file);
  if (skipLib.has(path.basename(file)) && !rel.includes(path.sep)) continue;
  if (rel === 'autopilotNext.ts' || rel === 'autoPipeline.ts' || rel === 'engDashboard.ts') continue;
  if (rel === 'websiteUrl.ts') continue;
  copyFile(file, path.join(veLib, rel));
}

const indexPath = path.join(veLib, 'index.ts');
let index = fs.readFileSync(indexPath, 'utf8');
if (!index.includes("export * from './legacyArchive'")) {
  index += `
export * from './legacyArchive';
export * from './legacyLinks';
export * from './projects';
export * from './types.legacy';
export * from './websiteUrl';
`;
  fs.writeFileSync(indexPath, index, 'utf8');
}

const heApi = path.join(appSrc, 'app', 'api', 'tools', 'hypothesis-engine');
const veApi = path.join(appSrc, 'app', 'api', 'tools', 'vertical-engine-v2');
for (const file of walk(heApi)) {
  const rel = path.relative(heApi, file);
  copyFile(file, path.join(veApi, rel));
}

const projectsRoute = path.join(veApi, 'projects', 'route.ts');
let projects = fs.readFileSync(projectsRoute, 'utf8');
if (!projects.includes('can_manage_legacy_links')) {
  projects = projects.replace(
    /return NextResponse\.json\(\{\s*projects:[\s\S]*?\}\);/,
    (match) => {
      const withPermissions = match.replace(
        /\}\);$/,
        `,
        permissions: { can_manage_legacy_links: authed.auth.role === 'admin' },
      });`,
      );
      return withPermissions.includes('permissions') ? withPermissions : match;
    },
  );
  fs.writeFileSync(projectsRoute, projects, 'utf8');
}

const heUi = path.join(appSrc, 'components', 'hypothesis-engine');
const veUi = path.join(appSrc, 'components', 'vertical-engine-v2', 'engine');
for (const file of walk(heUi)) {
  const rel = path.relative(heUi, file);
  copyFile(file, path.join(veUi, rel));
}

copyFile(
  path.join(root, 'app', 'worker', 'hypothesisEngine.ts'),
  path.join(root, 'app', 'worker', 'verticalEngineV2.ts'),
  { stripAutopilot: true },
);

const runnerPath = path.join(root, 'app', 'worker', 'runner.ts');
let runner = fs.readFileSync(runnerPath, 'utf8');
if (!runner.includes('vertical-engine-v2')) {
  runner = runner.replace(
    `  case 'hypothesisengine':
  case 'hypothesis-engine':
    run('./hypothesisEngine');
    break;`,
    `  case 'hypothesisengine':
  case 'hypothesis-engine':
    run('./hypothesisEngine');
    break;
  case 'verticalenginev2':
  case 'vertical-engine-v2':
    run('./verticalEngineV2');
    break;`,
  );
  fs.writeFileSync(runnerPath, runner, 'utf8');
}

console.log('copied vertical engine v2 runtime');
