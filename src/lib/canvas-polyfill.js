/**
 * node-canvas 与浏览器 Canvas API 统一适配层
 *
 * 在 node-canvas 环境中，ImageData 的行为与浏览器略有不同。
 * 这个文件在 node 端提供 polyfill，在浏览器端是空操作。
 */

// 检测是否在 Node.js 环境
const isNode = typeof window === 'undefined';

if (isNode) {
  // node-canvas 环境下的 ImageData polyfill
  global.ImageData = class ImageData {
    constructor(data, width, height) {
      this.data = data;
      this.width = width;
      this.height = height;
      // data.length / 4 应该等于 width * height
      if (height !== undefined) {
        this.height = height;
      } else {
        this.height = data.length / 4 / width;
      }
    }
  };
}

export {};
