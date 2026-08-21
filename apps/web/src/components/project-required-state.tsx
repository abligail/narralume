import { LibraryBig } from "lucide-react";
import { Link } from "react-router";

import { useI18n } from "../i18n";

import { Empty } from "./empty";

interface ProjectRequiredStateProps {
  seal: string;
  title: string;
  description: string;
}

/** 项目级页面的统一未选作品状态；页面内部的无内容状态仍使用 Empty。 */
export function ProjectRequiredState({
  seal,
  title,
  description,
}: ProjectRequiredStateProps) {
  const { t } = useI18n();
  return (
    <main className="project-required">
      <Empty
        seal={seal}
        sealVariant="hero"
        title={title}
        titleAs="h1"
        description={description}
        action={
          <Link className="btn btn--primary project-required__back" to="/shelf">
            <LibraryBig size={14} strokeWidth={1.5} aria-hidden="true" />
            {t("components.projectRequired.backToShelf")}
          </Link>
        }
      />
    </main>
  );
}
