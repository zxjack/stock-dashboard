import { NavLink, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  Grid3X3,
  BarChart3,
  Star,
  Bell,
} from 'lucide-react';
import styles from './MobileNav.module.css';

interface NavItem {
  path: string;
  label: string;
  icon: React.ReactNode;
}

const navItems: NavItem[] = [
  { path: '/', label: '总览', icon: <LayoutDashboard size={18} /> },
  { path: '/heatmap', label: '热力图', icon: <Grid3X3 size={18} /> },
  { path: '/rankings', label: '榜单', icon: <BarChart3 size={18} /> },
  { path: '/watchlist', label: '自选', icon: <Star size={18} /> },
  { path: '/monitor', label: '监控', icon: <Bell size={18} /> },
];

export function MobileNav() {
  const location = useLocation();

  return (
    <nav className={styles.mobileNav}>
      {navItems.map((item) => {
        const isActive =
          item.path === '/'
            ? location.pathname === '/'
            : location.pathname.startsWith(item.path);

        return (
          <NavLink
            key={item.path}
            to={item.path}
            className={`${styles.navItem} ${isActive ? styles.active : ''}`}
          >
            <span className={styles.icon}>{item.icon}</span>
            <span className={styles.label}>{item.label}</span>
          </NavLink>
        );
      })}
    </nav>
  );
}
