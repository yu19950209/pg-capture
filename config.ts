// 每个游戏的 spin 次数限制
export const SPIN_LIMIT = 50000;
// 购买游戏采集数量(每个类型)
export const BUY_LIMIT = 200;
// 加注模式采集数量(每个加注级别)
export const BET_LIMIT = 0;
// 重试次数
export const RETRY_ATTEMPTS = 10;
// 重试间隔（毫秒）
export const RETRY_DELAY_MS = 1;
// 每次 spin 后的延迟（毫秒）
export const SPIN_DELAY_MS = 1;
// 每隔多少行输出一次进度
export const LOG_INTERVAL = 1;
// 并行采集的游戏数量
export const CONCURRENT_GAMES = 10;
// 每个游戏的并发采集实例数
export const CONCURRENT_PER_GAME = 1;
// 导入最大限制 0 为不限制
export const IMPORT_LIMIT = 0;
// 测试RTP
export const TEST_RTP = true;