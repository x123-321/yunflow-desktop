/*
 * YunFlow (云流) — a desktop download accelerator built on multi-connection
 * ranged HTTP transfers.
 * Copyright (C) 2026 YunFlow Contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

import type { SVGProps } from 'react';

type Props = SVGProps<SVGSVGElement> & { size?: number };

function Icon({ size = 18, children, ...rest }: Props) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const DownloadIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M12 3v11" />
    <path d="m7.5 10 4.5 4.5L16.5 10" />
    <path d="M4 17.5V19a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1.5" />
  </Icon>
);

export const LayersIcon = (p: Props) => (
  <Icon {...p}>
    <path d="m12 3 8.5 4.5L12 12 3.5 7.5 12 3Z" />
    <path d="m3.5 12.5 8.5 4.5 8.5-4.5" />
    <path d="m3.5 17 8.5 4.5 8.5-4.5" />
  </Icon>
);

export const SettingsIcon = (p: Props) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06A1.7 1.7 0 0 0 15 19.4a1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9v.09a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51.91Z" />
  </Icon>
);

export const InfoIcon = (p: Props) => (
  <Icon {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 11v5.5" />
    <path d="M12 7.6h.01" />
  </Icon>
);

export const PlusIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M12 5v14M5 12h14" />
  </Icon>
);

export const PauseIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M9 5v14M15 5v14" />
  </Icon>
);

export const PlayIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M7 4.8v14.4l12-7.2-12-7.2Z" />
  </Icon>
);

export const TrashIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M4 7h16" />
    <path d="M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7" />
    <path d="M6.5 7l.8 12.1A2 2 0 0 0 9.3 21h5.4a2 2 0 0 0 2-1.9L17.5 7" />
  </Icon>
);

export const FolderIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M3.5 7.5A1.5 1.5 0 0 1 5 6h4l2 2.5h8A1.5 1.5 0 0 1 20.5 10v7.5A1.5 1.5 0 0 1 19 19H5a1.5 1.5 0 0 1-1.5-1.5v-10Z" />
  </Icon>
);

export const CloseIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </Icon>
);

export const LinkIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M10.5 13.5a3.8 3.8 0 0 0 5.4 0l2.6-2.6a3.8 3.8 0 0 0-5.4-5.4l-1.4 1.4" />
    <path d="M13.5 10.5a3.8 3.8 0 0 0-5.4 0l-2.6 2.6a3.8 3.8 0 0 0 5.4 5.4l1.4-1.4" />
  </Icon>
);

export const BoltIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M13 2 4.5 13.2h5.3L9.8 22 19 10.4h-5.6L13 2Z" />
  </Icon>
);

export const GaugeIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M4 18a8.5 8.5 0 1 1 16 0" />
    <path d="M12 18v-4.5" />
    <path d="m15.5 9.5-3.5 3.5" />
  </Icon>
);

export const AlertIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M12 4.2 21 19.5H3L12 4.2Z" />
    <path d="M12 10v4" />
    <path d="M12 17h.01" />
  </Icon>
);

export const CheckIcon = (p: Props) => (
  <Icon {...p}>
    <path d="m5 12.5 4.2 4.3L19 6.5" />
  </Icon>
);

export const ExternalIcon = (p: Props) => (
  <Icon {...p}>
    <path d="M13.5 4H20v6.5" />
    <path d="m20 4-9 9" />
    <path d="M18 14v5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 4 19V8a1.5 1.5 0 0 1 1.5-1.5h5" />
  </Icon>
);

export const HardDriveIcon = (p: Props) => (
  <Icon {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2.5" />
    <path d="M3 12h18" />
    <path d="M7 15.5h.01M11 15.5h.01" />
  </Icon>
);

export const UserIcon = (p: Props) => (
  <Icon {...p}>
    <circle cx="12" cy="8" r="3.6" />
    <path d="M4.5 20c.9-3.5 3.9-5.4 7.5-5.4s6.6 1.9 7.5 5.4" />
  </Icon>
);

export const ChevronIcon = (p: Props) => (
  <Icon {...p}>
    <path d="m9 6 6 6-6 6" />
  </Icon>
);

export const LogoMark = ({ size = 22 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path d="M4 15.5c3.2 0 3.2-4 6.4-4s3.2 4 6.4 4 3.2-4 6.4-4" stroke="#fff" strokeWidth="2" strokeLinecap="round" opacity="0.95" />
    <path d="M4 9.5c3.2 0 3.2-4 6.4-4s3.2 4 6.4 4 3.2-4 6.4-4" stroke="#fff" strokeWidth="2" strokeLinecap="round" opacity="0.55" />
  </svg>
);
