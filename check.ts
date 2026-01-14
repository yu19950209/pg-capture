#!/usr/bin/env ts-node
// PG 平台 Spin 数据验证 (TypeScript 版)
// Usage:
//   ts-node check.ts [--verbose|-v] [--remove|-r]

import fs from 'fs';
import path from 'path';
import Decimal from 'decimal.js';

const ASSETS_DIR = path.join(__dirname, 'assets');
const VERBOSE = process.argv.includes('--verbose') || process.argv.includes('-v');
const REMOVE_INVALID = process.argv.includes('--remove') || process.argv.includes('-r');
const PLATFORM = 'pg';

type LogEntry = { platform: string; game: string; file: string; message: string };
type InvalidRecord = { game: string; fileName: string; lineNum: number; filePath: string };

class PGSpinValidator {
	errors: LogEntry[] = [];
	warnings: LogEntry[] = [];
	invalidRecords: InvalidRecord[] = [];
	stats = {
		totalGames: 0,
		totalFiles: 0,
		totalSessions: 0,
		totalSpins: 0,
		stateErrors: 0,
		balanceMismatches: 0,
		npMismatches: 0,
		invalidWinCalc: 0,
		invalidFreeSpinSeq: 0,
		missingEndMarker: 0,
	};

	log(type: 'error' | 'warning', game: string, file: string, message: string) {
		const entry: LogEntry = { platform: PLATFORM, game: game || 'N/A', file: file || 'N/A', message };
		if (type === 'error') this.errors.push(entry); else this.warnings.push(entry);
	}

	validateSession(session: { record: any; lineNum: number }, game: string, fileName: string, filePath: string) {
		const { record, lineNum } = session;

		if (record.err != null) {
			this.log('error', game, fileName, `行${lineNum}: 无效记录 (err=${JSON.stringify(record.err)})`);
			this.stats.invalidWinCalc++;
			this.invalidRecords.push({ game, fileName, lineNum, filePath });
			return;
		}

		if (!Array.isArray(record.data) || record.data.length === 0) {
			this.log('error', game, fileName, `行${lineNum}: data 为空`);
			this.invalidRecords.push({ game, fileName, lineNum, filePath });
			return;
		}

		const spins = record.data
			.map((item: any, idx: number) => {
				if (!item?.dt?.si) return null;
				const si = item.dt.si;
				return {
					idx,
					st: si.st,
					nst: si.nst,
					psid: si.psid,
					sid: si.sid,
					bl: si.bl,
					blab: si.blab,
					tb: si.tb,
					tw: si.tw,
					np: si.np,
					ctw: si.ctw,
					fs: si.fs,
					wt: si.wt,
					aw: si.aw,
					fstc: si.fstc,
					pcwc: si.pcwc,
				};
			})
			.filter((s: any) => s !== null);

		if (spins.length === 0) {
			this.log('error', game, fileName, `行${lineNum}: 无有效 spin 数据`);
			return;
		}

		this.stats.totalSpins += spins.length;

		// 0) psid 一致性
		const firstPsid = spins[0].psid;
		spins.forEach((spin: any, i: number) => {
			if (spin.psid !== firstPsid) {
				this.log('error', game, fileName, `行${lineNum} spin[${i}]: psid 不一致 (期望=${firstPsid}, 实际=${spin.psid})`);
				this.stats.stateErrors++;
				if (!this.invalidRecords.some((r) => r.lineNum === lineNum && r.fileName === fileName)) {
					this.invalidRecords.push({ game, fileName, lineNum, filePath });
				}
			}
		});

		// 1) 第一个 st 必须为 1
		const firstSpin = spins[0];
		if (firstSpin.aw !== firstSpin.tw) {
			this.log('error', game, fileName, `行${lineNum} spin[0]: 第一个 spin 的 aw 必须等于 tw (aw=${firstSpin.aw}, tw=${firstSpin.tw})`);
			this.stats.stateErrors++;
			this.invalidRecords.push({ game, fileName, lineNum, filePath });
		}

		// 2) 第一个 st 必须为 1
		if (firstSpin.st !== 1) {
			this.log('error', game, fileName, `行${lineNum} spin[0]: 第一个 spin 的 st 必须是 1，当前为 ${firstSpin.st}`);
			this.stats.stateErrors++;
			this.invalidRecords.push({ game, fileName, lineNum, filePath });
		}

		// 3) 最后一个 nst 必须为 1
		const lastSpinObj = spins[spins.length - 1];
		if (lastSpinObj.nst !== 1) {
			this.log('error', game, fileName, `行${lineNum} spin[${spins.length - 1}]: 最后一个 spin 的 nst 必须是 1，当前为 ${lastSpinObj.nst}`);
			this.stats.stateErrors++;
			this.invalidRecords.push({ game, fileName, lineNum, filePath });
		}

		// 4) st -> nst 连续性
		for (let i = 0; i < spins.length - 1; i++) {
			const curr = spins[i];
			const next = spins[i + 1];
			if (curr.nst != null && next.st != null && curr.nst !== next.st) {
				this.log('error', game, fileName, `行${lineNum} spin[${i}]: 状态不连续 (nst=${curr.nst} → st=${next.st})`);
				this.stats.stateErrors++;
				if (!this.invalidRecords.some((r) => r.lineNum === lineNum && r.fileName === fileName)) {
					this.invalidRecords.push({ game, fileName, lineNum, filePath });
				}
			}
		}

		// 5) np = tw - tb
		spins.forEach((spin: any, i: number) => {
			if (spin.np != null && spin.tw != null && spin.tb != null) {
				const expected = spin.tw - spin.tb;
				if (Math.abs(expected - spin.np) > 0.01) {
					this.log('error', game, fileName, `行${lineNum} spin[${i}]: 净利润计算错误 (tw=${spin.tw}, tb=${spin.tb}, np=${spin.np}, 期望=${expected})`);
					this.stats.npMismatches++;
					if (!this.invalidRecords.some((r) => r.lineNum === lineNum && r.fileName === fileName)) {
						this.invalidRecords.push({ game, fileName, lineNum, filePath });
					}
				}
			}
		});

		// 6) Free Spin 序列校验（仅在 type==2 时严格检查）
		if (record.type === 2 && spins[0].fs) {
			const fsInfo = spins[0].fs;

			if (fsInfo.ts != null) {
				const spinCount = spins.filter((s: any) => s.wt !== 'C').length; // 不包括 collect
				if (VERBOSE && spinCount !== fsInfo.ts) {
					this.log('warning', game, fileName, `行${lineNum}: Free Spin 数量不匹配 (声明=${fsInfo.ts}, 实际=${spinCount})`);
				}
			}

			const last = spins[spins.length - 1];
			if (last.wt !== 'C') {
				this.log('warning', game, fileName, `行${lineNum}: Free Spin 最后应为 wt='C'，当前为 '${last.wt}'`);
				this.stats.missingEndMarker++;
				if (!this.invalidRecords.some((r) => r.lineNum === lineNum && r.fileName === fileName)) {
					this.invalidRecords.push({ game, fileName, lineNum, filePath });
				}
			}

			if (fsInfo.aw != null) {
				const totalWin = new Decimal(fsInfo.aw);
				const calculatedWin = spins.reduce((sum: Decimal, s: any) => {
					if (s.aw != null && s.aw > 0) return sum.plus(new Decimal(s.aw));
					return sum;
				}, new Decimal(0));

				if (totalWin.minus(calculatedWin).abs().greaterThan(new Decimal(0.1))) {
					if (VERBOSE) {
						this.log('warning', game, fileName, `行${lineNum}: Free Spin 总赢额不匹配 (声明=${fsInfo.aw}, 计算=${calculatedWin.toFixed(2)})`);
					}
				}
			}
		}
	}

	validateGameFiles(game: string) {
		const gameDir = path.join(ASSETS_DIR, PLATFORM, game);
		if (!fs.existsSync(gameDir)) return;

		const files = fs
			.readdirSync(gameDir)
			.filter((f) => f.startsWith('Spin.') && f.endsWith('.jsonl'));

		if (files.length === 0) return;

		this.stats.totalGames++;
		this.stats.totalFiles += files.length;

		let sessionCount = 0;
		files.forEach((fileName) => {
			const filePath = path.join(gameDir, fileName);
			const content = fs.readFileSync(filePath, 'utf8');
			const lines = content.split('\n').filter((l) => l.trim());

			lines.forEach((line, idx) => {
				try {
					const record = JSON.parse(line);
					sessionCount++;
					this.stats.totalSessions++;
					this.validateSession({ record, lineNum: idx + 1 }, game, fileName, filePath);
				} catch (err: any) {
					this.log('error', game, fileName, `行${idx + 1}: JSON 解析失败 - ${err.message}`);
				}
			});
		});

		console.log(`  ✓ ${game.padEnd(24)} ${files.length} 文件, ${sessionCount} 会话`);
	}

	validatePlatform() {
		console.log(`\n📋 验证 PG 平台`);
		console.log('─'.repeat(80));

		const platformDir = path.join(ASSETS_DIR, PLATFORM);
		if (!fs.existsSync(platformDir)) {
			console.log(`  ⚠️  目录不存在: ${platformDir}`);
			return;
		}

		const games = fs
			.readdirSync(platformDir)
			.filter((f) => fs.statSync(path.join(platformDir, f)).isDirectory())
			.sort();

		games.forEach((game) => this.validateGameFiles(game));
	}

	printReport(): number {
		console.log('\n' + '='.repeat(80));
		console.log('📊 PG 平台验证报告');
		console.log('='.repeat(80));

		console.log('\n统计信息:');
		console.log(`  游戏数: ${this.stats.totalGames}`);
		console.log(`  配置文件: ${this.stats.totalFiles}`);
		console.log(`  会话数: ${this.stats.totalSessions}`);
		console.log(`  转动次数: ${this.stats.totalSpins}`);

		console.log('\n数据一致性问题:');
		console.log(`  状态流转错误: ${this.stats.stateErrors}`);
		console.log(`  净利润计算错误: ${this.stats.npMismatches}`);
		console.log(`  无效记录: ${this.stats.invalidWinCalc}`);
		console.log(`  Free Spin 序列错误: ${this.stats.invalidFreeSpinSeq}`);
		console.log(`  缺少结算标记: ${this.stats.missingEndMarker}`);

		if (this.errors.length > 0) {
			console.log(`\n❌ 错误 (${this.errors.length} 个):`);
			this.errors.slice(0, 50).forEach((err) => {
				console.log(`  [${err.game}/${err.file}] ${err.message}`);
			});
			if (this.errors.length > 50) {
				console.log(`  ... 还有 ${this.errors.length - 50} 个错误`);
			}
		}

		if (this.warnings.length > 0 && VERBOSE) {
			console.log(`\n⚠️  警告 (${this.warnings.length} 个):`);
			this.warnings.slice(0, 50).forEach((warn) => {
				console.log(`  [${warn.game}/${warn.file}] ${warn.message}`);
			});
			if (this.warnings.length > 50) {
				console.log(`  ... 还有 ${this.warnings.length - 50} 个警告`);
			}
		}

		console.log('\n' + '='.repeat(80));

		if (this.errors.length === 0) {
			console.log('✅ PG 平台数据验证通过！');
			return 0;
		} else {
			console.log(`❌ 发现 ${this.errors.length} 个错误，${this.warnings.length} 个警告`);

			if (REMOVE_INVALID && this.invalidRecords.length > 0) {
				console.log(`\n🗑️  移除 ${this.invalidRecords.length} 个无效记录...`);
				this.removeInvalidRecords();
			}

			return 1;
		}
	}

	removeInvalidRecords() {
		const fileMap = new Map<string, { filePath: string; lineNums: number[] }>();
		this.invalidRecords.forEach((rec) => {
			const key = `${rec.game}/${rec.fileName}`;
			if (!fileMap.has(key)) fileMap.set(key, { filePath: rec.filePath, lineNums: [] });
			fileMap.get(key)!.lineNums.push(rec.lineNum);
		});

		let removedTotal = 0;
		const failedFiles: string[] = [];

		fileMap.forEach((data, fileKey) => {
			try {
				const content = fs.readFileSync(data.filePath, 'utf8');
				const lines = content.split('\n');
				const originalCount = lines.length;

				const backupPath = data.filePath + '.bak';
				fs.writeFileSync(backupPath, content);

				const lineNumsSet = new Set(data.lineNums);
				const validLines = lines.filter((line, idx) => !lineNumsSet.has(idx + 1));

				const expectedCount = originalCount - lineNumsSet.size;
				if (validLines.length !== expectedCount) {
					throw new Error(`行数不匹配: 期望 ${expectedCount}, 实际 ${validLines.length}`);
				}

				fs.writeFileSync(data.filePath, validLines.join('\n'));

				const newContent = fs.readFileSync(data.filePath, 'utf8');
				if (newContent.split('\n').length === validLines.length) {
					fs.unlinkSync(backupPath);
					console.log(`  ✓ ${data.filePath}`);
					console.log(`    移除 ${lineNumsSet.size} 行 (${originalCount} → ${validLines.length})`);
					removedTotal += lineNumsSet.size;
				} else {
					fs.copyFileSync(backupPath, data.filePath);
					throw new Error('写入验证失败，已恢复备份');
				}
			} catch (err: any) {
				console.error(`  ✗ ${fileKey}: ${err.message}`);
				failedFiles.push(fileKey);
			}
		});

		console.log(`\n✅ 成功移除 ${removedTotal} 个无效记录`);
		if (failedFiles.length > 0) {
			console.log(`⚠️  ${failedFiles.length} 个文件处理失败: ${failedFiles.join(', ')}`);
		}
	}

	run(): number {
		console.log('🔍 开始 PG 平台 Spin 数据验证...');
		if (REMOVE_INVALID) console.log('⚠️  删除模式已启用，将自动删除无效记录！');
		this.validatePlatform();
		return this.printReport();
	}
}

const validator = new PGSpinValidator();
const exitCode = validator.run();
process.exit(exitCode);
