/*!
 * Build of the admin tab "Time machine": src-tab (React, vite) => admin/tab.html + admin/assets.
 * The backend is compiled before by `npm run build-backend` (tsc).
 *
 *   tsx tasks.ts            all steps
 *   tsx tasks.ts --0-clean  removes the built tab
 *   tsx tasks.ts --1-npm    installs the packages of src-tab
 *   tsx tasks.ts --2-build  builds src-tab
 *   tsx tasks.ts --3-copy   copies the build into admin/
 */
import { existsSync, rmSync } from 'node:fs';
import { buildReact, copyFiles, npmInstall } from '@iobroker/build-tools';

const srcTab = `${__dirname}/src-tab/`;

/** Removes the built tab; jsonConfig.json, jsonCustom.json, i18n and the icon in admin/ stay */
function clean(): void {
    for (const path of ['admin/tab.html', 'admin/assets', 'src-tab/build']) {
        rmSync(`${__dirname}/${path}`, { recursive: true, force: true });
    }
}

/** Installs the packages of src-tab, if not done yet (`npm run 1-npm` installs again) */
function install(force = false): Promise<void> {
    if (!force && existsSync(`${srcTab}node_modules`)) {
        return Promise.resolve();
    }
    return npmInstall(srcTab);
}

function build(): Promise<void> {
    return buildReact(srcTab, { rootDir: __dirname, vite: true });
}

function copy(): void {
    copyFiles(['src-tab/build/**/*'], 'admin/');
}

function fail(step: string): (e: unknown) => never {
    return (e: unknown): never => {
        console.error(`Cannot ${step}: ${String(e)}`);
        process.exit(1);
    };
}

if (process.argv.includes('--0-clean')) {
    clean();
} else if (process.argv.includes('--1-npm')) {
    install(true).catch(fail('install the packages of src-tab'));
} else if (process.argv.includes('--2-build')) {
    build().catch(fail('build src-tab'));
} else if (process.argv.includes('--3-copy')) {
    copy();
} else {
    clean();
    install()
        .then(() => build())
        .then(() => copy())
        .catch(fail('build the admin tab'));
}
