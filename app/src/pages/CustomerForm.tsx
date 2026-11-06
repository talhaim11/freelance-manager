import { useRef, useState } from 'react';
import { useRepo } from '../App';
import { errorMessage } from '../domain/errors';
import { uuid } from '../lib/uuid';
import { Dialog, Field, useBusy } from '../ui/kit';
import type { Customer } from '../data/types';

export const EMPTY_CUSTOMER: Omit<Customer, 'id'> = { name: '', tax_id: '', address: '', email: '', phone: '' };

export function CustomerFields({ form, setForm, nameError, requireAddress }: {
  form: Omit<Customer, 'id'>; setForm: (f: Omit<Customer, 'id'>) => void; nameError?: string | null; requireAddress?: boolean;
}) {
  return (
    <div className="grid grid-2">
      <Field label="שם (חובה)" error={nameError}>{(a) => <input {...a} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
      <Field label="ח.פ. / ת.ז.">{(a) => <input {...a} dir="ltr" inputMode="numeric" value={form.tax_id} onChange={(e) => setForm({ ...form, tax_id: e.target.value })} />}</Field>
      <Field label={requireAddress ? 'כתובת (נדרשת לחשבונית עסקה)' : 'כתובת'} hint={requireAddress ? undefined : 'נדרשת להפקת חשבונית עסקה.'}>
        {(a) => <input {...a} value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />}
      </Field>
      <Field label="דוא״ל">{(a) => <input {...a} type="email" dir="ltr" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />}</Field>
      <Field label="טלפון">{(a) => <input {...a} type="tel" dir="ltr" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />}</Field>
    </div>
  );
}

/**
 * Adds a customer without leaving the current page: the document being written stays as it is.
 * One client key per opening, so a double click or a retry after a lost response adds one customer.
 */
export function NewCustomerDialog({ open, onClose, onCreated, requireAddress }: {
  open: boolean; onClose: () => void; onCreated: (c: Customer) => void; requireAddress?: boolean;
}) {
  const repo = useRepo();
  const { busy, run } = useBusy();
  const [form, setForm] = useState(EMPTY_CUSTOMER);
  const [error, setError] = useState<string | null>(null);
  const [tried, setTried] = useState(false);
  const key = useRef(uuid());

  const close = () => { setError(null); setTried(false); onClose(); };
  const submit = () => run(async () => {
    setTried(true); setError(null);
    if (!form.name.trim()) return;
    try {
      const c = await repo.addCustomer(form, key.current);
      key.current = uuid();
      setForm(EMPTY_CUSTOMER); setTried(false);
      onCreated(c);
    } catch (e) { setError(errorMessage(e)); }
  });

  return (
    <Dialog open={open} title="לקוח חדש" onClose={close}>
      <form onSubmit={(e) => { e.preventDefault(); e.stopPropagation(); void submit(); }} noValidate>
        <p className="muted">הלקוח יישמר ויסומן במסמך. מה שכבר מילאת במסמך נשאר כפי שהוא.</p>
        <CustomerFields form={form} setForm={setForm} requireAddress={requireAddress}
          nameError={tried && !form.name.trim() ? 'שם הלקוח הוא שדה חובה' : null} />
        {error && <p className="notice notice-error" role="alert">{error}</p>}
        <div className="btn-row">
          <button className="btn" type="submit" disabled={busy}>{busy ? 'שומר…' : 'שמירת לקוח'}</button>
          <button className="btn btn-secondary" type="button" onClick={close} disabled={busy}>חזרה למסמך</button>
        </div>
      </form>
    </Dialog>
  );
}
