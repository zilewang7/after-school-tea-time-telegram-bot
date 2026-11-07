interface LengthCounterProps {
    length: number;
    max: number;
}

/** "12/200" next to a field label, red once over the limit */
export const LengthCounter = ({ length, max }: LengthCounterProps) => (
    <span className={length > max ? 'error-text' : 'hint'}>
        {length}/{max}
    </span>
);
