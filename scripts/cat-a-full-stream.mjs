import fetch from 'node-fetch';
import vm from 'node:vm';
import fs from 'node:fs';

// ===================== 配置区 =====================
const sourceUrl = "https://9280.kstore.vip/cat/index.js";
const outputFile = "./cat-A-可播放.m3u";
const MAX_PAGE = 10;        // 测试先用10页，跑通后再改成99
const PAGE_DELAY = 1200;    // Actions服务器IP容易被限流，延时加大
const MOVIE_DELAY = 600;
const VM_TIMEOUT = 15000;
// ==================================================

// 转义，防止逗号破坏m3u语法
function escapeName(str) {
  if (!str) return "";
  return String(str)
    .replace(/,/g, "，")
    .replace(/[\n\r]/g, " ")
    .replace(/"/g, "'");
}

// 拉取cat源JS源码
async function getJsCode() {
  const res = await fetch(sourceUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
    }
  });
  if (!res.ok) throw new Error(`HTTP 请求失败 status=${res.status}`);
  return await res.text();
}

// 沙盒执行cat js，传入query参数
async function runCat(jsCode, query = {}) {
  const sandbox = {
    req: { query },
    res: {},
    setResult(o) {
      sandbox.__ret = o;
    }
  };
  vm.runInNewContext(jsCode, sandbox, { timeout: VM_TIMEOUT });
  return sandbox.__ret;
}

async function main() {
  console.log("📥 正在拉取 cat index.js 源码 ...");
  const jsCode = await getJsCode();
  console.log("✅ JS源码拉取完成，开始初始化获取分类");

  // 初始化，获取分类列表
  const initData = await runCat(jsCode, { class: "", pg: "0" });
  if (!initData || !initData.classes) {
    throw new Error("❌ 获取分类列表失败，源结构可能已经变更！");
  }
  const classes = initData.classes;
  console.log(`✅ 分类总数：${classes.length}`);

  const streamList = [];
  const seenUrl = new Set(); // 去重

  // 遍历所有分类
  for (const cls of classes) {
    const cid = cls.type_id;
    const cname = cls.type_name;
    console.log(`\n========== 分类【${cname}】 type_id=${cid} ==========`);

    // 翻页
    for (let pg = 1; pg <= MAX_PAGE; pg++) {
      let pageData;
      try {
        pageData = await runCat(jsCode, { class: cid, pg: String(pg) });
      } catch (err) {
        console.log(`⚠️ 第${pg}页执行报错：${err.message}，跳过该页`);
        await new Promise(r => setTimeout(r, PAGE_DELAY));
        continue;
      }

      if (!pageData || !pageData.list || pageData.list.length === 0) {
        console.log(`⏹ 分类【${cname}】第${pg}页无影片，结束当前分类翻页`);
        break;
      }
      console.log(`✅ 第${pg}页：${pageData.list.length} 部影片，开始解析播放线路`);

      // 遍历本页影片，解析详情
      for (const movie of pageData.list) {
        const movieName = movie.name;
        const movieUrl = movie.url;
        if (!movieUrl) continue;
        try {
          // 解析影片详情 + 播放线路
          const detail = await runCat(jsCode, { url: movieUrl });
          if (!detail || !detail.list) continue;

          for (const line of detail.list) {
            const realStream = line.url;
            if (!realStream) continue;
            if (seenUrl.has(realStream)) continue; // 去重
            seenUrl.add(realStream);

            const title = escapeName(`${movieName}【${line.name || "线路"}】`);
            streamList.push({
              group: escapeName(cname),
              title,
              url: realStream
            });
          }
        } catch (err) {
          console.log(`❌ 影片【${movieName}】解析失败：${err.message}，跳过`);
        }
        await new Promise(r => setTimeout(r, MOVIE_DELAY));
      }
      await new Promise(r => setTimeout(r, PAGE_DELAY));
    }
  }

  console.log(`\n🎉 全部解析完成！有效播放线路总数：${streamList.length}`);

  // 生成标准M3U
  let m3uText = "#EXTM3U\n";
  for (const s of streamList) {
    m3uText += `#EXTINF:-1 group-title="${s.group}",${s.title}\n${s.url}\n`;
  }

  fs.writeFileSync(outputFile, m3uText, "utf8");
  console.log(`✅ 输出文件：${outputFile}`);
}

main().catch(e => {
  console.error("💥 主程序异常：", e);
  process.exit(1);
});
