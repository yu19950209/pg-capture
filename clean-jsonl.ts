import fs from 'fs';
import path from 'path';

const targetDir = path.join(__dirname, 'assets');

function processFile(filePath: string) {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n');
        const newLines: string[] = [];
        let changed = false;

        for (const line of lines) {
            if (!line.trim()) {
                newLines.push(line);
                continue;
            }
            try {
                const data = JSON.parse(line);
                let modified = false;
                if ('mul' in data) {
                    delete data.mul;
                    modified = true;
                }
                if ('type' in data) {
                    delete data.type;
                    modified = true;
                }

                if (modified) {
                    newLines.push(JSON.stringify(data));
                    changed = true;
                } else {
                    newLines.push(line);
                }
            } catch (e) {
                // 如果解析失败，保留原行
                newLines.push(line);
            }
        }

        if (changed) {
            fs.writeFileSync(filePath, newLines.join('\n'), 'utf8');
            console.log(`Updated ${filePath}`);
        }
    } catch (e) {
        console.error(`Failed to process ${filePath}:`, e);
    }
}

function walkDir(dir: string) {
    if (!fs.existsSync(dir)) return;
    const files = fs.readdirSync(dir);
    for (const file of files) {
        const fullPath = path.join(dir, file);
        const stat = fs.statSync(fullPath);
        if (stat.isDirectory()) {
            walkDir(fullPath);
        } else if (file.endsWith('.jsonl')) {
            processFile(fullPath);
        }
    }
}

if (require.main === module) {
    console.log(`Scanning ${targetDir} for .jsonl files...`);
    walkDir(targetDir);
    console.log('Done.');
}
