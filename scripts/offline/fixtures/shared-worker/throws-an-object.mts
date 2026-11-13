/** Fixture: throws something that is not an Error, outside of any case */
import '../../harness.mts';

throw { code: 42, detail: 'a thrown plain object' };
