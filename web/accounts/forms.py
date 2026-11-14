"""Email-and-password forms on top of Django's user model.

The email address, lower-cased, is stored as the username so sign-in is
case-insensitive and unique without replacing the user model.
"""
from django import forms
from django.contrib.auth import authenticate, get_user_model, password_validation

User = get_user_model()


class SignUpForm(forms.Form):
    email = forms.EmailField(max_length=150)
    password = forms.CharField(strip=False)
    password_again = forms.CharField(strip=False)

    def clean_email(self):
        email = self.cleaned_data['email'].strip().lower()
        if User.objects.filter(username=email).exists():
            raise forms.ValidationError('An account with this email address already exists. Sign in instead.')
        return email

    def clean(self):
        data = super().clean()
        password = data.get('password')
        if password and data.get('password_again') != password:
            self.add_error('password_again', 'The two passwords do not match.')
        if password:
            try:
                password_validation.validate_password(password, User(username=data.get('email', ''), email=data.get('email', '')))
            except forms.ValidationError as error:
                self.add_error('password', error)
        return data

    def save(self):
        email = self.cleaned_data['email']
        return User.objects.create_user(username=email, email=email, password=self.cleaned_data['password'])


class SignInForm(forms.Form):
    email = forms.EmailField(max_length=150)
    password = forms.CharField(strip=False)

    def __init__(self, request=None, *args, **kwargs):
        self.request, self.user = request, None
        super().__init__(*args, **kwargs)

    def clean(self):
        data = super().clean()
        if data.get('email') and data.get('password'):
            self.user = authenticate(self.request, username=data['email'].strip().lower(), password=data['password'])
            if self.user is None:
                # One message for both cases, so the form does not reveal which emails have accounts.
                raise forms.ValidationError('The email address or password is not correct.')
        return data
