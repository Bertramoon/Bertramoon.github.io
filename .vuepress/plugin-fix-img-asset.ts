import type { Plugin } from "vuepress";
import * as path from "path";

export const fixImgAssetPlugin: Plugin = {
  name: "fix-img-asset",
  extendsMarkdown: (md, app) => {
    const defaultRender = md.renderer.rules.image || function (tokens, idx, options, env, self) {
      return self.renderToken(tokens, idx, options);
    };

    // 处理 markdown-it 的 html_inline token 中的 <img> 标签
    md.core.ruler.push("fix-html-img-asset", (state) => {
      const filePathRelative = state.env.filePathRelative;
      if (!filePathRelative) return;

      const dir = path.dirname(filePathRelative).replace(/\\/g, "/");

      for (const token of state.tokens) {
        if (token.type === "html_block" || token.type === "html_inline") {
          token.content = token.content.replace(
            /(<img\s+[^>]*src=")([^"]*\.assets\/[^"]+)(")/g,
            (match: string, prefix: string, imgPath: string, suffix: string) => {
              if (imgPath.startsWith("@source/") || imgPath.startsWith("/")) {
                return match;
              }
              const full = dir === "." ? imgPath : `${dir}/${imgPath}`;
              return `${prefix}@source/${full}${suffix}`;
            }
          );
        }
      }
    });
  },
};
