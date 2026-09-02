import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import Login from './Login';
import { useAuth } from '../hooks/useAuth';
import { ApiError } from '../api/client';

vi.mock('../hooks/useAuth');
const navigateMock = vi.fn();
vi.mock('react-router-dom', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-router-dom')>()),
  useNavigate: () => navigateMock,
}));

describe('Login', () => {
  beforeEach(() => navigateMock.mockClear());

  it('calls login() and navigates to /library on success', async () => {
    const login = vi.fn().mockResolvedValue(undefined);
    vi.mocked(useAuth).mockReturnValue({ login } as any);
    render(<MemoryRouter><Login /></MemoryRouter>);

    await userEvent.type(screen.getByPlaceholderText('Email'), 'a@example.com');
    await userEvent.type(screen.getByPlaceholderText('Password'), 'secret');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(login).toHaveBeenCalledWith('a@example.com', 'secret');
    expect(navigateMock).toHaveBeenCalledWith('/library');
  });

  it('shows the backend\'s error message on failure, without navigating', async () => {
    const login = vi.fn().mockRejectedValue(new ApiError(401, 'invalid email or password'));
    vi.mocked(useAuth).mockReturnValue({ login } as any);
    render(<MemoryRouter><Login /></MemoryRouter>);

    await userEvent.type(screen.getByPlaceholderText('Email'), 'a@example.com');
    await userEvent.type(screen.getByPlaceholderText('Password'), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('invalid email or password')).toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalled();
  });
});
