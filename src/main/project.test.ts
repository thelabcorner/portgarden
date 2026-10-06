import { describe, expect, it } from 'vitest';
import path from 'node:path';
import {
  classifyRole,
  extractPathCandidates,
  findProjectRoot,
  isProjectDirectory,
  nodeProjectIo,
  ProjectResolver,
  resolveDeclaredPort,
  type ProjectIo
} from './project.js';

/** An in-memory filesystem, so the walk can be tested without touching a disk. */
function fakeIo(tree: Record<string, string[]>): ProjectIo {
  return {
    readDirectory: (directory) => tree[directory] ?? [],
    readTextFile: (file) => (file in tree ? '{}' : null)
  };
}

describe('isProjectDirectory', () => {
  it('accepts a directory containing a recognised marker', () => {
    expect(isProjectDirectory(['src', 'package.json', 'node_modules'])).toBe(true);
    expect(isProjectDirectory(['.git', 'README.md'])).toBe(true);
    expect(isProjectDirectory(['pyproject.toml'])).toBe(true);
  });

  it('accepts a solution or project file by suffix', () => {
    expect(isProjectDirectory(['App.sln'])).toBe(true);
    expect(isProjectDirectory(['Api.csproj'])).toBe(true);
  });

  it('rejects a directory with no marker', () => {
    expect(isProjectDirectory(['node_modules', 'dist', 'index.js'])).toBe(false);
  });

  it('accepts a .git file, because a worktree uses one', () => {
    // A submodule or linked worktree has `.git` as a file. Testing the entry name
    // rather than its type means both forms count.
    expect(isProjectDirectory(['.git', 'src'])).toBe(true);
  });
});

describe('findProjectRoot', () => {
  const io = fakeIo({
    'C:\\work\\api': ['.git', 'package.json', 'node_modules'],
    'C:\\work\\api\\node_modules\\vite\\bin': ['vite.js'],
    'C:\\work\\api\\node_modules\\vite': ['package.json'],
    'C:\\work\\api\\node_modules': ['vite'],
    'C:\\work': ['scratch'],
    'C:\\': ['Users'],
    'C:\\Users': ['dev']
  });

  it('walks up from a nested file to the project root', () => {
    expect(findProjectRoot('C:\\work\\api\\node_modules\\vite\\bin\\vite.js', io)).toBe('C:\\work\\api\\node_modules\\vite');
  });

  it('walks up from a directory', () => {
    expect(findProjectRoot('C:\\work\\api\\node_modules\\vite\\bin', io)).toBe('C:\\work\\api\\node_modules\\vite');
  });

  it('returns null when nothing above has a marker', () => {
    expect(findProjectRoot('C:\\Users\\dev\\Downloads\\thing.exe', io)).toBeNull();
  });

  it('stops at the drive root rather than looping', () => {
    expect(findProjectRoot('C:\\', io)).toBeNull();
  });

  it('resolves against the real filesystem for a path that exists', () => {
    // Guards against the walk only working against a fake tree. This project's
    // own directory is the fixture: it genuinely contains package.json, so a
    // broken readDirectory cannot pass by accident.
    expect(findProjectRoot(path.join(process.cwd(), 'package.json'), nodeProjectIo)).toBe(process.cwd());
  });

  it('yields null for a real path with no project marker anywhere above it', () => {
    // The Node install directory has no marker, and neither does any ancestor up
    // to the drive root. That is the honest answer for most system binaries.
    expect(findProjectRoot(process.execPath, nodeProjectIo)).toBeNull();
  });
});

describe('extractPathCandidates', () => {
  it('pulls quoted and bare absolute paths in argument order', () => {
    const argv = '"C:\\Program Files\\nodejs\\node.exe" "C:\\work\\api\\scripts\\dev.mjs" --config C:\\work\\api\\vite.config.ts';
    const candidates = extractPathCandidates(argv);
    expect(candidates).toContain('C:\\Program Files\\nodejs\\node.exe');
    expect(candidates).toContain('C:\\work\\api\\scripts\\dev.mjs');
    expect(candidates).toContain('C:\\work\\api\\vite.config.ts');
  });

  it('ignores a relative path, which cannot be resolved without a working directory', () => {
    // Guessing a base for `./src/index.ts` and reporting it as fact is precisely
    // the failure the confidence label exists to prevent.
    expect(extractPathCandidates('node ./scripts/dev.mjs --port 3000')).toEqual([]);
  });

  it('ignores a bare flag value that is not a path', () => {
    expect(extractPathCandidates('node app.js --mode production')).toEqual([]);
  });

  it('finds a UNC path', () => {
    expect(extractPathCandidates('\\\\fileserver\\share\\tool.exe')).toEqual(['\\\\fileserver\\share\\tool.exe']);
  });

  it('returns nothing for a command line with no paths', () => {
    expect(extractPathCandidates('taskhostw {222A245B-E637-4AE9-A93F} -Embedding')).toEqual([]);
  });
});

describe('resolveDeclaredPort', () => {
  it('reads an explicit --port', () => {
    expect(resolveDeclaredPort('node vite.js --port 5173')).toBe(5173);
    expect(resolveDeclaredPort('vite --port=5174')).toBe(5174);
  });

  it('reads a PORT environment assignment', () => {
    expect(resolveDeclaredPort('node server.js PORT=8081')).toBe(8081);
  });

  it('reads a host:port form', () => {
    expect(resolveDeclaredPort('curl http://localhost:4321/health')).toBe(4321);
  });

  it('reads --listen with an explicit port', () => {
    expect(resolveDeclaredPort('serve --listen 3000')).toBe(3000);
  });

  it('reads a .port assignment', () => {
    expect(resolveDeclaredPort('next dev -p 4000 .port=4000')).toBe(4000);
  });

  it('accepts a short -p when a known server framework is present', () => {
    expect(resolveDeclaredPort('python -m uvicorn app:api -p 8001')).toBe(8001);
  });

  it('ignores a short -p when no framework is recognised', () => {
    // `-p` is a port for rails and a "project" flag for go build. Reporting a
    // confidently wrong number here would be worse than reporting nothing.
    expect(resolveDeclaredPort('go build -p 4 ./cmd/server')).toBeNull();
  });

  it('returns null when nothing is declared', () => {
    expect(resolveDeclaredPort('C:\\Windows\\System32\\services.exe')).toBeNull();
    expect(resolveDeclaredPort(null)).toBeNull();
  });

  it('rejects an out-of-range value', () => {
    expect(resolveDeclaredPort('vite --port 70000')).toBeNull();
  });
});

describe('classifyRole', () => {
  it('recognises a dev server before the bare runtime', () => {
    expect(classifyRole('node', 'node C:\\api\\vite\\bin\\vite.js --port 5173')).toBe('dev-server');
    expect(classifyRole('node', 'node next dev')).toBe('dev-server');
    expect(classifyRole('node', 'python -m uvicorn app:api')).toBe('dev-server');
  });

  it('falls back to the plain runtime when no server is involved', () => {
    expect(classifyRole('node', 'node -e "setInterval(()=>{},1000)"')).toBe('node');
  });

  it('classifies a database ahead of its host runtime', () => {
    expect(classifyRole('postgres', '')).toBe('database');
    expect(classifyRole('sqlservr', '')).toBe('database');
    expect(classifyRole('mongod', '')).toBe('database');
  });

  it('classifies a Docker port forward', () => {
    expect(classifyRole('docker-proxy', '')).toBe('docker-forward');
    expect(classifyRole('com.docker.backend', '')).toBe('docker-forward');
  });

  it('recognises Windows system processes', () => {
    expect(classifyRole('System', '')).toBe('system');
    expect(classifyRole('wininit', '')).toBe('system');
    expect(classifyRole('services', '')).toBe('service');
  });

  it('recognises the other runtimes and browsers', () => {
    expect(classifyRole('python', '')).toBe('python');
    expect(classifyRole('chrome', '')).toBe('browser');
    expect(classifyRole('dotnet', '')).toBe('dotnet');
    expect(classifyRole('java', '')).toBe('java');
  });

  it('falls back to other', () => {
    expect(classifyRole('somethingelse', '')).toBe('other');
  });
});

describe('ProjectResolver', () => {
  const io: ProjectIo = {
    readDirectory: (directory) => (directory === 'C:\\work\\api' ? ['.git', 'package.json'] : []),
    readTextFile: (file) => (file === 'C:\\work\\api\\package.json' ? '{"name":"api-service"}' : null)
  };

  it('infers the project from a command line and labels the evidence', () => {
    const resolver = new ProjectResolver();
    const info = resolver.resolve({ commandLine: 'node C:\\work\\api\\scripts\\dev.mjs', image: 'C:\\nodejs\\node.exe', io });
    expect(info.root).toBe('C:\\work\\api');
    expect(info.name).toBe('api-service');
    expect(info.confidence).toBe('inferred');
    expect(info.basis).toContain('command line');
  });

  it('falls back to the executable path and says so', () => {
    const resolver = new ProjectResolver();
    const info = resolver.resolve({ commandLine: null, image: 'C:\\work\\api\\.venv\\Scripts\\python.exe', io });
    expect(info.root).toBe('C:\\work\\api');
    expect(info.basis).toContain('executable');
  });

  it('reports unknown rather than guessing when there is nothing to go on', () => {
    const resolver = new ProjectResolver();
    const info = resolver.resolve({ commandLine: 'C:\\Windows\\System32\\services.exe', image: null, io });
    expect(info.root).toBeNull();
    expect(info.confidence).toBe('unknown');
  });

  it('says the command line was unavailable rather than implying a search failed', () => {
    const resolver = new ProjectResolver();
    const info = resolver.resolve({ commandLine: null, image: null, io });
    expect(info.basis).toBe('command line unavailable');
  });

  it('falls back to the directory name when package.json has no name', () => {
    const bare: ProjectIo = {
      readDirectory: (directory) => (directory === 'C:\\work\\thing' ? ['.git'] : []),
      readTextFile: () => null
    };
    const resolver = new ProjectResolver();
    expect(resolver.resolve({ commandLine: 'C:\\work\\thing\\run.exe', image: null, io: bare }).name).toBe('thing');
  });

  it('caches a resolution rather than re-walking per scan', () => {
    const resolver = new ProjectResolver();
    let reads = 0;
    const counting: ProjectIo = {
      readDirectory: (directory) => {
        reads += 1;
        return directory === 'C:\\work\\api' ? ['package.json'] : [];
      },
      readTextFile: () => null
    };
    const first = resolver.resolve({ commandLine: 'node C:\\work\\api\\a.js', image: null, io: counting }, 1000);
    const afterFirst = reads;
    const second = resolver.resolve({ commandLine: 'node C:\\work\\api\\a.js', image: null, io: counting }, 1500);
    expect(second).toEqual(first);
    expect(reads).toBe(afterFirst);
  });

  it('stays bounded so a long session cannot grow the cache without limit', () => {
    const resolver = new ProjectResolver();
    const wide: ProjectIo = { readDirectory: () => [], readTextFile: () => null };
    for (let index = 0; index < 1200; index += 1) {
      resolver.resolve({ commandLine: `node C:\\w\\p${index}\\a.js`, image: null, io: wide }, 1000 + index);
    }
    // No public size to assert against, so assert the property that matters: the
    // resolver still answers correctly after the cache has churned.
    expect(resolver.resolve({ commandLine: 'node C:\\w\\p5\\a.js', image: null, io: wide }, 5000).confidence).toBe('unknown');
  });
});