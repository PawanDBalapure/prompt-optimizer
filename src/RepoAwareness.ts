import * as fs from 'fs';
import * as path from 'path';

export interface RepoStackInfo {
  frameworks: string[];
  orm: string[];
  auth: string[];
  styling: string[];
  languages: string[];
  patterns: string[];
  summary: string;
}

/**
 * Heuristically inspects a workspace root to infer the project stack and architecture summaries
 */
export function inferRepoStack(workspaceRoot?: string): RepoStackInfo {
  const info: RepoStackInfo = {
    frameworks: [],
    orm: [],
    auth: [],
    styling: [],
    languages: [],
    patterns: [],
    summary: 'Standard codebase structure',
  };

  if (!workspaceRoot || !fs.existsSync(workspaceRoot)) {
    return info;
  }

  try {
    // 1. Scan package.json
    const packageJsonPath = path.join(workspaceRoot, 'package.json');
    if (fs.existsSync(packageJsonPath)) {
      info.languages.push('TypeScript/JavaScript');
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      const deps = {
        ...(pkg.dependencies ?? {}),
        ...(pkg.devDependencies ?? {}),
      };

      // Frameworks
      if (deps['next']) info.frameworks.push('Next.js');
      if (deps['react']) info.frameworks.push('React');
      if (deps['express']) info.frameworks.push('Express');
      if (deps['@nestjs/core']) info.frameworks.push('NestJS');
      if (deps['vue']) info.frameworks.push('Vue');
      if (deps['nuxt']) info.frameworks.push('Nuxt');
      if (deps['@angular/core']) info.frameworks.push('Angular');

      // ORM / Database
      if (deps['prisma'] || deps['@prisma/client']) info.orm.push('Prisma');
      if (deps['mongoose']) info.orm.push('Mongoose (MongoDB)');
      if (deps['typeorm']) info.orm.push('TypeORM');
      if (deps['sequelize']) info.orm.push('Sequelize');
      if (deps['drizzle-orm']) info.orm.push('Drizzle ORM');

      // Auth
      if (deps['@clerk/nextjs'] || deps['@clerk/clerk-sdk-node']) info.auth.push('Clerk');
      if (deps['next-auth'] || deps['@auth/core']) info.auth.push('NextAuth');
      if (deps['auth0'] || deps['@auth0/nextjs-auth0']) info.auth.push('Auth0');
      if (deps['firebase-admin'] || deps['firebase']) info.auth.push('Firebase Auth');

      // Styling
      if (deps['tailwindcss']) info.styling.push('Tailwind CSS');
      if (deps['@mui/material']) info.styling.push('Material UI');
      if (deps['@chakra-ui/react']) info.styling.push('Chakra UI');
    }

    // 2. Scan other workspace files/folders to detect languages/other frameworks
    const files = fs.readdirSync(workspaceRoot);
    if (files.includes('build.gradle.kts') || files.includes('build.gradle') || files.includes('settings.gradle.kts')) {
      info.languages.push('Kotlin/Java');
      info.frameworks.push('Gradle/Spring Boot');
    }
    if (files.includes('pom.xml')) {
      info.languages.push('Java');
      info.frameworks.push('Maven/Spring Boot');
    }
    if (files.includes('requirements.txt') || files.includes('pyproject.toml') || files.includes('Pipfile')) {
      info.languages.push('Python');
      if (fs.existsSync(path.join(workspaceRoot, 'manage.py'))) {
        info.frameworks.push('Django');
      } else {
        info.frameworks.push('FastAPI/Flask');
      }
    }
    if (files.includes('Cargo.toml')) {
      info.languages.push('Rust');
    }
    if (files.includes('go.mod')) {
      info.languages.push('Go');
    }

    // Next.js App Router vs Pages Router check
    const hasAppDir = fs.existsSync(path.join(workspaceRoot, 'app')) || 
                      fs.existsSync(path.join(workspaceRoot, 'src', 'app'));
    const hasPagesDir = fs.existsSync(path.join(workspaceRoot, 'pages')) || 
                        fs.existsSync(path.join(workspaceRoot, 'src', 'pages'));
    
    if (hasAppDir && info.frameworks.includes('Next.js')) {
      info.frameworks.push('Next.js App Router');
      info.patterns.push('App-Router routing convention');
    } else if (hasPagesDir && info.frameworks.includes('Next.js')) {
      info.frameworks.push('Next.js Pages Router');
      info.patterns.push('Pages-Router routing convention');
    }

    // Coding convention inferences
    if (fs.existsSync(path.join(workspaceRoot, 'tsconfig.json'))) {
      info.patterns.push('Strict TypeScript');
    }
    if (fs.existsSync(path.join(workspaceRoot, '.eslintrc.json')) || fs.existsSync(path.join(workspaceRoot, 'eslint.config.js'))) {
      info.patterns.push('ESLint standard rules');
    }
    if (fs.existsSync(path.join(workspaceRoot, 'prisma', 'schema.prisma'))) {
      info.orm.push('Prisma schema definitions');
    }

  } catch (err) {
    // Suppress file system read errors
  }

  // Generate robust summary
  const summaryParts: string[] = [];
  if (info.languages.length > 0) {
    summaryParts.push(`Languages: ${[...new Set(info.languages)].join(', ')}`);
  }
  const frameworksSet = [...new Set(info.frameworks)];
  if (frameworksSet.length > 0) {
    summaryParts.push(`Frameworks: ${frameworksSet.join(', ')}`);
  }
  const ormSet = [...new Set(info.orm)];
  if (ormSet.length > 0) {
    summaryParts.push(`ORM/Database: ${ormSet.join(', ')}`);
  }
  const authSet = [...new Set(info.auth)];
  if (authSet.length > 0) {
    summaryParts.push(`Authentication: ${authSet.join(', ')}`);
  }
  const styleSet = [...new Set(info.styling)];
  if (styleSet.length > 0) {
    summaryParts.push(`Styling: ${styleSet.join(', ')}`);
  }
  const patternsSet = [...new Set(info.patterns)];
  if (patternsSet.length > 0) {
    summaryParts.push(`Conventions: ${patternsSet.join(', ')}`);
  }

  if (summaryParts.length > 0) {
    info.summary = `Workspace Tech Stack:\n` + summaryParts.map((s) => ` - ${s}`).join('\n');
  }

  return info;
}
