// 一个结构上模仿真实 LM Studio bundle 的最小样本。
// 真实 bundle 中对应的模块 id 是 72114；这里刻意用别的数字，
// 以证明实现不依赖具体 id。
//
// 格式说明：真实 bundle 是压缩代码，模块之间以 ',' 直接相连、无换行，
// 因此本 fixture 按真实格式紧凑书写（用 + 拼接只是为了让源文件按模块分行可读，
// 运行时字符串内没有任何换行）。语言目录模块同时覆盖两种引用写法：
// en 用「变量先绑定再引用」（const r=(t=>t.default)(a(10001)); {sidebar:r}），
// zh/sw 用「对象内联」（{sidebar:(t=>t.default)(a(20001))}）。
export const MINI = `(()=>{var __webpack_modules__={` +
  `38801:(t,e)=>{"use strict";Object.defineProperty(e,"__esModule",{value:!0}),e.EnglishStrings=e.ChineseCNStrings=e.SwedishStrings=void 0;` +
  `const r=(t=>t.default)(a(10001)),i=(t=>t.default)(a(10002)),o=(t=>t.default)(a(10003)),p=(t=>t.default)(a(10004));` +
  `const en={sidebar:r,chat:i,config:o,models:p};e.EnglishStrings=en;` +
  `const zh={sidebar:(t=>t.default)(a(20001)),chat:(t=>t.default)(a(20002)),config:(t=>t.default)(a(20003)),models:(t=>t.default)(a(20004))};e.ChineseCNStrings=zh;` +
  `const sw={sidebar:(t=>t.default)(a(30001)),chat:(t=>t.default)(a(30002)),config:(t=>t.default)(a(30003)),models:(t=>t.default)(a(30004))};e.SwedishStrings=sw},` +
  `10001:t=>{"use strict";t.exports=JSON.parse('{"chat":"Chat","discover":"Discover","runtimes":"Runtime","settings":"Settings"}')},` +
  `10002:t=>{"use strict";t.exports=JSON.parse('{"send":"Send message","stop":"Stop generating","rename":"Rename chat","onlyInEn":"Only in English"}')},` +
  `10003:t=>{"use strict";t.exports=JSON.parse('{"contextLength":"Context Length","onlyInEn":"Another English only"}')},` +
  `10004:t=>{"use strict";t.exports=JSON.parse('{"pinned":"Pinned","onlyInEn":"Third English only"}')},` +
  `20001:t=>{"use strict";t.exports=JSON.parse('{"chat":"\\u804a\\u5929","discover":"\\u53d1\\u73b0","runtimes":"\\u8fd0\\u884c\\u73af\\u5883","settings":"\\u8bbe\\u7f6e"}')},` +
  `20002:t=>{"use strict";t.exports=JSON.parse('{"send":"\\u53d1\\u9001\\u6d88\\u606f","stop":"\\u505c\\u6b62\\u751f\\u6210","rename":"\\u91cd\\u547d\\u540d"}')},` +
  `20003:t=>{"use strict";t.exports=JSON.parse('{"contextLength":"\\u4e0a\\u4e0b\\u6587\\u957f\\u5ea6"}')},` +
  `20004:t=>{"use strict";t.exports=JSON.parse('{"pinned":"\\u5df2\\u56fa\\u5b9a"}')},` +
  `30001:t=>{"use strict";t.exports=JSON.parse('{"chat":"Chatt","discover":"Uppt\\u00e4ck","runtimes":"Runtime","settings":"Inst\\u00e4llningar"}')},` +
  `30002:t=>{"use strict";t.exports=JSON.parse('{"send":"Skicka meddelande","stop":"Stoppa generering","rename":"Byt namn"}')},` +
  `30003:t=>{"use strict";t.exports=JSON.parse('{"contextLength":"Kontextl\\u00e4ngd"}')},` +
  `30004:t=>{"use strict";t.exports=JSON.parse('{"pinned":"F\\u00e4st"}')}` +
  `};function a(id){return {default:__webpack_modules__[id]};}return __webpack_modules__;})()`;
