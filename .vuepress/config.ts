import { defineUserConfig } from "vuepress";
import recoTheme from "vuepress-theme-reco";
import { viteBundler } from '@vuepress/bundler-vite'
import { webpackBundler } from '@vuepress/bundler-webpack'

export default defineUserConfig({
  title: "Bertram的云笔记",
  description: "个人云笔记，记录个人学习和工作中的一些知识和感悟",
  lang: "zh-CN",
  bundler: viteBundler(),
  // bundler: webpackBundler(),
  theme: recoTheme({
    logo: "/head.jpg",
    docsRepo: "https://github.com/Bertramoon/Bertramoon.github.io",
    docsBranch: "main",
    lastUpdated: true,
    lastUpdatedText: "最后更新时间",
    author: "Bertram",
    authorAvatar: "/head.jpg",
    friendshipLinks: [
      {
        logo: "/github.svg",
        title: "GitHub",
        link: "https://github.com/Bertramoon",
      },
    ],
    categoriesText: "分类",
    tagsText: "标签",
    autoSetSeries: true,
    autoSetBlogCategories: true,
    autoAddCategoryToNavbar: {
      location: 1, // 插入位置，默认 0
      showIcon: true, // 展示图标，默认 false
    },
    navbar: [
      { text: "主页", link: "/", icon: "IconHome" },
      { text: "博客", link: "/posts", icon: "IconBlog" },
      {
        text: "WIKI",
        icon: "IconNote",
        children: [
          { text: "安全架构与设计", link: "/series/security_architecture_design/", icon: "IconDesign" },
          { text: "安全编码", link: "/series/security_code/", icon: "IconDev" },
          { text: "安全测试", link: "/series/security_test/", icon: "IconSecurity" },
          { text: "安全开发生命周期", link: "/series/sdl/", icon: "IconCycle" },
        ],
      },
      { text: "发布时间线", link: "/timeline", icon: "IconTimeline" },
      { text: "友情链接", link: "/friendship-link", icon: "IconFriendship" },
    ],
  }),
  markdown: {
    headers: {
      level: [1, 2, 3]
    },
    toc: {
      level: [1, 2, 3, 4]
    }
  }
});
