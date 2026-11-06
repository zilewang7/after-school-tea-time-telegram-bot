import { Link } from 'react-router';

interface NavListItemProps {
    to: string;
    label: string;
}

/** A list row that navigates to another panel page */
export const NavListItem = ({ to, label }: NavListItemProps) => (
    <li>
        <Link className="list-link" to={to}>
            <span className="list-title">
                <span>{label}</span>
                <span className="chevron" aria-hidden="true">
                    ›
                </span>
            </span>
        </Link>
    </li>
);
