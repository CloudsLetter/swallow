/**
 * 内置 OS 品牌图标索引（Simple Icons / 单色源，经 CSS mask 以 currentColor 渲染）。
 * 文件名 = osId（与后端 normalize_os_id 输出、Tab.osId、host.icon 的 `os:` 前缀对齐）。
 */
import ubuntu from './ubuntu.svg';
import debian from './debian.svg';
import centos from './centos.svg';
import rhel from './rhel.svg';
import rocky from './rocky.svg';
import fedora from './fedora.svg';
import arch from './arch.svg';
import manjaro from './manjaro.svg';
import mint from './mint.svg';
import pop from './pop.svg';
import alpine from './alpine.svg';
import kali from './kali.svg';
import nixos from './nixos.svg';
import raspbian from './raspbian.svg';
import opensuse from './opensuse.svg';
import elementary from './elementary.svg';
import gentoo from './gentoo.svg';
import linux from './linux.svg';
import windows from './windows.svg';
import macos from './macos.svg';

/** osId → 图标 URL（vite 打包为资源 URL） */
export const OS_ICON_URLS: Record<string, string> = {
  ubuntu,
  debian,
  centos,
  rhel,
  rocky,
  fedora,
  arch,
  manjaro,
  mint,
  pop,
  alpine,
  kali,
  nixos,
  raspbian,
  opensuse,
  elementary,
  gentoo,
  linux,
  windows,
  macos,
};
