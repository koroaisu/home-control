import {readFileSync, writeFileSync, existsSync, realpathSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {execFileSync} from 'node:child_process';

const root = path.dirname(fileURLToPath(import.meta.url));
const plugin = path.join(root, 'streamdeck', 'com.koroaisu.homecontrol.sdPlugin');
const cliPackage = path.join(root, 'node_modules', '@elgato', 'cli', 'package.json');
if (!existsSync(cliPackage)) throw new Error('先に npm ci を実行してください（開発用の公式Stream Deck CLIを使います）');
const metadata = JSON.parse(readFileSync(cliPackage, 'utf8'));
const cli = path.resolve(path.dirname(cliPackage), typeof metadata.bin === 'string' ? metadata.bin : metadata.bin.streamdeck);
const run = (...args) => execFileSync(process.execPath, [cli, ...args], {stdio: 'inherit', cwd: root, windowsHide: true});
writeFileSync(path.join(plugin, 'connection.json'), JSON.stringify({projectRoot: root}, null, 2));
run('validate', plugin);
const installed = path.join(process.env.APPDATA, 'Elgato', 'StreamDeck', 'Plugins', 'com.koroaisu.homecontrol.sdPlugin');
if (existsSync(installed)) {
  if (realpathSync(installed).toLowerCase() !== realpathSync(plugin).toLowerCase()) {
    throw new Error('同名プラグインが別の場所にあります。既存ファイルを保護するため処理を中止しました');
  }
} else {
  run('link', plugin);
}
run('restart', 'com.koroaisu.homecontrol');
console.log('Home Controlを登録しました。Stream Deckのアクション一覧で「Home Control」を探してください。');
console.log('初回登録後に表示されない場合は、Stream Deckを通知領域から終了して再起動してください。開発者モードが無効だと単体のrestartは反映されません。');
