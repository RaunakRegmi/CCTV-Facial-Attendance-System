import base64
import binascii
from io import BytesIO
from typing import Annotated
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, ConfigDict, Field, field_validator

Identifier = Annotated[str, Field(min_length=1, max_length=100, pattern=r'^[A-Za-z0-9][A-Za-z0-9_.-]*$')]
Name = Annotated[str, Field(min_length=1, max_length=200)]


class Input(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)


class Login(Input):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=1, max_length=1024)

    model_config = ConfigDict(extra='forbid', str_strip_whitespace=False)


class ClassCreate(Input):
    class_id: Identifier
    class_name: Name
    room: str | None = Field(default=None, max_length=100)


class StudentCreate(Input):
    student_id: Identifier
    full_name: Name
    enrolled_classes: list[Identifier] = Field(min_length=1, max_length=30)
    photo_base64: str = Field(max_length=900000)

    @field_validator('photo_base64')
    @classmethod
    def validate_photo(cls, value):
        try:
            prefix, encoded = value.split(',', 1)
            if prefix != 'data:image/jpeg;base64':
                raise ValueError('Photo must be a JPEG data URL')
            raw = base64.b64decode(encoded, validate=True)
            with Image.open(BytesIO(raw)) as image:
                if image.format != 'JPEG' or max(image.size) > 400 or min(image.size) < 1:
                    raise ValueError('Photo must be a JPEG no larger than 400px')
                image.verify()
        except (ValueError, binascii.Error, UnidentifiedImageError, OSError, Image.DecompressionBombError) as exc:
            raise ValueError('Invalid JPEG photo (maximum dimension 400px)') from exc
        return value
