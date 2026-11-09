import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const root = process.cwd();
const publicDirectory = resolve(root, 'public');
const vendorDirectory = resolve(publicDirectory, 'vendor');

mkdirSync(vendorDirectory, { recursive: true });
cpSync(resolve(root, 'node_modules/bootstrap/dist'), resolve(vendorDirectory, 'bootstrap'), { recursive: true });
cpSync(resolve(root, 'node_modules/bootstrap-icons/font'), resolve(vendorDirectory, 'bootstrap-icons'), { recursive: true });

const outputsFile = resolve(root, 'amplify_outputs.json');
if (existsSync(outputsFile)) {
	cpSync(outputsFile, resolve(publicDirectory, 'amplify_outputs.json'));
} else if (process.env.AWS_BRANCH) {
	throw new Error('Amplify não gerou amplify_outputs.json antes do build do frontend.');
}