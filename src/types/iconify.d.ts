import type { DetailedHTMLProps, HTMLAttributes } from "react";

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      "iconify-icon": DetailedHTMLProps<
        HTMLAttributes<HTMLElement>,
        HTMLElement
      > & {
        icon: string;
        width?: string | number;
        height?: string | number;
        flip?: string;
        rotate?: string | number;
        mode?: string;
        inline?: boolean | string;
      };
    }
  }
}
