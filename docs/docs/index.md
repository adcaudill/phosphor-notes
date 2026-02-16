---
title: Documentation
layout: page
permalink: /docs/
---

Complete guides and technical documentation for Phosphor Notes.

{% assign all_docs = site.pages | where_exp: "page", "page.path contains 'docs' and page.name != 'index.md' and page.path != 'docs/index.md' and page.layout != 'home' and page.layout != nil" | sort: "title" %}

{% if all_docs.size > 0 %}

## Quick Links

{% for doc in all_docs %}
  {% assign parts = doc.path | split: '/' %}
  {% if parts.size == 2 %}
- [{{ doc.title | default: doc.name }}]({{ doc.url }})
  {% endif %}
{% endfor %}

{% assign folder_names = "" %}
{% for doc in all_docs %}
  {% assign parts = doc.path | split: '/' %}
  {% if parts.size > 2 %}
    {% assign folder = parts[1] %}
    {% unless folder_names contains folder %}
      {% if folder_names == "" %}
        {% assign folder_names = folder %}
      {% else %}
        {% assign folder_names = folder_names | append: "||" | append: folder %}
      {% endif %}
    {% endunless %}
  {% endif %}
{% endfor %}

{% if folder_names != "" %}
  {% assign folders = folder_names | split: "||" | sort %}
  {% for folder in folders %}
    {% assign folder_count = 0 %}
    {% for doc in all_docs %}
      {% assign parts = doc.path | split: '/' %}
      {% if parts.size > 2 and parts[1] == folder %}
        {% assign folder_count = folder_count | plus: 1 %}
      {% endif %}
    {% endfor %}
- [{{ folder | replace: '_', ' ' | capitalize }}](#{{ folder | replace: '_', '-' }}) ({{ folder_count }} pages)
  {% endfor %}
{% endif %}

## Root Documentation

{% assign has_root = false %}
{% for doc in all_docs %}
  {% assign parts = doc.path | split: '/' %}
  {% if parts.size == 2 %}
    {% assign has_root = true %}
    {% break %}
  {% endif %}
{% endfor %}

{% if has_root %}
<div class="docs-grid">
  {% for doc in all_docs %}
    {% assign parts = doc.path | split: '/' %}
    {% if parts.size == 2 %}
      <div class="docs-item">
        <h3><a href="{{ doc.url }}">{{ doc.title | default: doc.name }}</a></h3>
        {% if doc.excerpt %}
        <p>{{ doc.excerpt }}</p>
        {% endif %}
      </div>
    {% endif %}
  {% endfor %}
</div>
{% endif %}

## Topics

{% if folder_names != "" %}
{% assign folders = folder_names | split: "||" | sort %}
{% for folder in folders %}
### {{ folder | replace: '_', ' ' | capitalize }} {#{{ folder | replace: '_', '-' }}}

<div class="docs-group">
{% for doc in all_docs %}
{% assign parts = doc.path | split: '/' %}
{% if parts.size > 2 and parts[1] == folder %}
<div class="docs-item">
<h4><a href="{{ doc.url }}">{{ doc.title | default: doc.name }}</a></h4>
{% if doc.excerpt %}
<p>{{ doc.excerpt }}</p>
{% endif %}
</div>
{% endif %}
{% endfor %}
</div>
{% endfor %}
{% endif %}

{% else %}

No documentation pages found yet. Check back soon!

{% endif %}
