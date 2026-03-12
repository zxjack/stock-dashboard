/**
 * 热力图页面（大盘云图嵌入版）
 * 需求：仅保留中间主体区域，去掉上方与左侧干扰区
 */

import styles from './Heatmap.module.css';

const YUNTU_URL = 'https://52etf.site/';

export function Heatmap() {
  return (
    <div className={styles.heatmap}>
      <div className={styles.frameWrap}>
        <iframe
          src={YUNTU_URL}
          title="大盘云图"
          className={styles.frame}
          loading="lazy"
          referrerPolicy="no-referrer"
        />
      </div>
    </div>
  );
}
